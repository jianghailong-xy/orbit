package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// batchPinServer stands in for POST /api/runner/tasks/batch-pin and records the path and body, so
// what the terminal actually sends is what the assertions read.
func batchPinServer(t *testing.T) (*httptest.Server, *string, *map[string]interface{}) {
	t.Helper()
	var gotPath string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"changed":37425}`))
	}))
	t.Cleanup(srv.Close)
	configureCLITestRunner(t, srv.URL)
	return srv, &gotPath, &gotBody
}

func TestTaskCLIBatchPinSendsTheSelectionAndPrintsWhatChanged(t *testing.T) {
	_, gotPath, gotBody := batchPinServer(t)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{
		"batch-pin",
		"--project", "01a02d83-7c58-708c-8d7c-103d15523d70",
		"--label", "CC-MAIN-2017-34,shard-002",
		"--task-id", "aaaaaaaa-1111-4111-8111-111111111111",
		"--task-id", "aaaaaaaa-1111-4111-8111-111111111111,bbbbbbbb-2222-4222-8222-222222222222",
		"--model", "deepseek-flash",
		"--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if *gotPath != "/api/runner/tasks/batch-pin" {
		t.Fatalf("path = %q", *gotPath)
	}
	// The filter travels as one field the server applies, not as an id list the client had to read
	// out of the project first — that is the whole shape of this door.
	if (*gotBody)["projectId"] != "01a02d83-7c58-708c-8d7c-103d15523d70" {
		t.Fatalf("projectId = %#v", (*gotBody)["projectId"])
	}
	if (*gotBody)["model"] != "deepseek-flash" {
		t.Fatalf("model = %#v", (*gotBody)["model"])
	}
	// Repeated at a terminal so a label containing a comma survives, and deduplicated here rather
	// than sent twice.
	labels, ok := (*gotBody)["labels"].([]interface{})
	if !ok || len(labels) != 2 || labels[0] != "CC-MAIN-2017-34" || labels[1] != "shard-002" {
		t.Fatalf("labels = %#v", (*gotBody)["labels"])
	}
	ids, ok := (*gotBody)["taskIds"].([]interface{})
	if !ok || len(ids) != 2 {
		t.Fatalf("taskIds = %#v", (*gotBody)["taskIds"])
	}
	// provider was never named, so it must not appear at all: a null here would clear every pin.
	if _, present := (*gotBody)["provider"]; present {
		t.Fatalf("provider must be absent when unnamed, got %#v", (*gotBody)["provider"])
	}
	if !strings.Contains(out.String(), `"changed":37425`) {
		t.Fatalf("out = %q", out.String())
	}
}

func TestTaskCLIBatchPinSendsAnExplicitNullToClearAPin(t *testing.T) {
	_, _, gotBody := batchPinServer(t)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{
		"batch-pin", "--list-id", "01a02d83-7c58-708c-8d7c-103d15523d70", "--clear-model", "--clear-provider", "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	// Present-and-null, which is the clear: absent would leave the pin alone.
	value, present := (*gotBody)["model"]
	if !present || value != nil {
		t.Fatalf("model = %#v (present=%v), want an explicit null", value, present)
	}
	if value, present := (*gotBody)["provider"]; !present || value != nil {
		t.Fatalf("provider = %#v (present=%v), want an explicit null", value, present)
	}
}

// The two refusals this door has are the server's; the terminal says which flag is missing first,
// because that is the whole difference between a caller fixing it and decoding a request.
func TestTaskCLIBatchPinRefusesNoSelectorAndNoPin(t *testing.T) {
	batchPinServer(t)

	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{
			name: "no selector",
			args: []string{"batch-pin", "--model", "deepseek-flash"},
			want: "--project",
		},
		{
			name: "no pin",
			args: []string{"batch-pin", "--project", "01a02d83-7c58-708c-8d7c-103d15523d70"},
			want: "--provider and/or --model",
		},
		{
			name: "clear beside set",
			args: []string{"batch-pin", "--project", "01a02d83-7c58-708c-8d7c-103d15523d70", "--model", "m", "--clear-model"},
			want: "--clear-model and --model cannot be used together",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			err := cmdTaskCLI(tc.args, strings.NewReader(""), &out)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one naming %q", err, tc.want)
			}
		})
	}
}
