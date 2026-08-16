package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTaskCLIListSendsLabelsAsRepeatedQueryParams(t *testing.T) {
	var gotQuery []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()["labels"]
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{
		"list", "--label", "CC-MAIN-2017-34,shard-002", "--label", "rerun", "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	// Repeated rather than comma-joined, so a label containing a comma survives the round trip.
	if len(gotQuery) != 3 ||
		gotQuery[0] != "CC-MAIN-2017-34" || gotQuery[1] != "shard-002" || gotQuery[2] != "rerun" {
		t.Fatalf("labels query = %#v", gotQuery)
	}
}

func TestTaskCLICreateAndUpdateSendLabels(t *testing.T) {
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"t1"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{
		"create", "--title", "ingest shard", "--label", "CC-MAIN-2017-34", "--label", "CC-MAIN-2017-34,shard-002", "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	labels, ok := gotBody["labels"].([]interface{})
	if !ok || len(labels) != 2 || labels[0] != "CC-MAIN-2017-34" || labels[1] != "shard-002" {
		t.Fatalf("create labels = %#v", gotBody["labels"])
	}

	// --clear-labels is the only way to say "no labels": an empty --label is rejected, so the
	// clear cannot be typed by accident.
	out.Reset()
	if err := cmdTaskCLI([]string{
		"update", "00000000-0000-7000-8000-0000000000b1", "--clear-labels", "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	cleared, ok := gotBody["labels"].([]interface{})
	if !ok || len(cleared) != 0 {
		t.Fatalf("cleared labels = %#v", gotBody["labels"])
	}

	err := cmdTaskCLI([]string{
		"update", "00000000-0000-7000-8000-0000000000b1", "--clear-labels", "--label", "x", "--json",
	}, strings.NewReader(""), &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "cannot be used together") {
		t.Fatalf("conflicting label flags error = %v", err)
	}
}

func TestTaskCLILabelsCallsSummaryEndpoint(t *testing.T) {
	var gotPath, gotList string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotList = r.URL.Query().Get("listId")
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"items":[],"labelTotal":0,"truncated":false}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"labels", "--list-id", "list-9", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if gotPath != "/api/runner/tasks/labels" || gotList != "list-9" {
		t.Fatalf("request = %s?listId=%s", gotPath, gotList)
	}
	if strings.TrimSpace(out.String()) != `{"items":[],"labelTotal":0,"truncated":false}` {
		t.Fatalf("--json output = %q", out.String())
	}
}
