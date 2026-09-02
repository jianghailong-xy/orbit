package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The third consumer of the API's answer to a database conflict.
//
// When PostgreSQL rolls a request's transaction back — a deadlock victim, a failed serialization —
// the apiserver's boundary answers 503 with a fixed body and a stable code instead of the 500 it
// used to. The web reads that body (src/web/src/api.test.ts) and so does this CLI, which is what
// an agent and a person at a terminal actually see. Two things have to hold here and nowhere else:
// the code and the message reach the caller instead of being flattened into "500 Internal Server
// Error", and the runner's own retry policy recognises the status as one worth re-sending.
//
// The contract itself is declared once, in src/shared/src/dbConflict.ts. Go cannot import it, so
// the constants below are a mirror — and TestTransientDBConflictMirrorsTheSharedContract reads
// that file to make a rename over there fail over here rather than drift quietly.
const (
	transientDBConflictCode              = "TRANSIENT_DB_CONFLICT"
	transientDBConflictMessage           = "the database rolled this request back to break a conflict with a concurrent write; nothing was saved, so the same request can be sent again"
	transientDBConflictRetryAfterSeconds = "1"
)

// The body the apiserver serves, byte for byte.
func transientDBConflictBody(t *testing.T) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]interface{}{
		"statusCode":        503,
		"error":             "Service Unavailable",
		"code":              transientDBConflictCode,
		"message":           transientDBConflictMessage,
		"retryable":         true,
		"retryAfterSeconds": 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// A control plane whose database threw this request's transaction away.
func conflictingServer(t *testing.T) *httptest.Server {
	t.Helper()
	body := transientDBConflictBody(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Header().Set("Retry-After", transientDBConflictRetryAfterSeconds)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestCLIShowsTheServersAnswerToADatabaseConflict(t *testing.T) {
	srv := conflictingServer(t)
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "index the corpus", "--completion-criterion", "EVIDENCE_JUDGMENT"}, strings.NewReader(""), &out)
	if err == nil {
		t.Fatal("task create reported success against a server that refused the write")
	}

	// What the person or the agent reads. The code is the part they can act on: it says the write
	// did not happen and the same command will probably work, which a bare 503 does not.
	text := err.Error()
	for _, want := range []string{"503", transientDBConflictCode, "nothing was saved"} {
		if !strings.Contains(text, want) {
			t.Errorf("the CLI error does not carry %q:\n%s", want, text)
		}
	}
	// And nothing about the database that produced it — the same claim the server-side contract
	// test makes about the body, asserted where it is finally printed.
	for _, forbidden := range []string{"UPDATE ", "SELECT ", "40001", "40P01", "sk-ant"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("the CLI error repeats %q:\n%s", forbidden, text)
		}
	}
}

func TestRunnerTreatsADatabaseConflictAsRetryableAndARefusalAsFinal(t *testing.T) {
	conflict := conflictingServer(t)
	if _, err := NewTransport(conflict.URL, "tok").getTask("341DOGTVEs0Fk0gAn1mje"); err == nil {
		t.Fatal("the transport reported success on a 503")
	} else if !isRetryableTransportError(err) {
		// A conflict is the one 5xx that is certain to be worth re-sending: nothing was written.
		t.Errorf("a database conflict is not being retried: %v", err)
	}

	refusal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"statusCode":409,"code":"TURN_ALREADY_CLOSED","message":"that turn is closed"}`))
	}))
	defer refusal.Close()
	if _, err := NewTransport(refusal.URL, "tok").getTask("341DOGTVEs0Fk0gAn1mje"); err == nil {
		t.Fatal("the transport reported success on a 409")
	} else if isRetryableTransportError(err) {
		// The other half: a business refusal answers the same way every time, and retrying one is
		// how a client spends a quota on a decision that has already been made.
		t.Errorf("a business refusal is being retried: %v", err)
	}
}

func TestTransientDBConflictMirrorsTheSharedContract(t *testing.T) {
	path := filepath.Join("..", "shared", "src", "dbConflict.ts")
	source, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("no %s in this checkout, so the mirror cannot be compared: %v", path, err)
	}
	// Substring, not a parse: the point is only that the strings this file hardcodes are still the
	// ones the server serves. A rename or a reworded message shows up here as a failing mirror.
	for _, want := range []string{
		"'" + transientDBConflictCode + "'",
		"'" + transientDBConflictMessage + "'",
		"TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS = " + transientDBConflictRetryAfterSeconds,
	} {
		if !strings.Contains(string(source), want) {
			t.Errorf("%s no longer declares %s — this mirror is stale", path, want)
		}
	}
}
