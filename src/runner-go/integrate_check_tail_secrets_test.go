//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// What a result carries of a check's output is held to what the log is held to: this machine's
// secrets and a URL's userinfo do not leave it, whichever claim the result is under and whether or
// not the check passed. And what the uploader sends is text the control plane can store: a NUL does
// not cost the log a chunk, and a chunk that is not delivered does not cost the log the ones after it.
//
// Every case here names only what the runner had before any of that was done, so this file compiles
// against the old code and shows what the old code did. The passwords and tokens are made up.

const (
	tailPassword = "s3cret-pass"
	tailToken    = "the-runners-secret-token-0123456789"
	tailAddress  = "postgres://app:" + tailPassword + "@db/orbit"
	tailRedacted = "postgres://[redacted]@db/orbit"
)

// assertNoSecretLeft fails when text holds any of the secrets.
func assertNoSecretLeft(t *testing.T, where, text string, secrets ...string) {
	t.Helper()
	for _, secret := range secrets {
		if strings.Contains(text, secret) {
			t.Errorf("%s carries %q: it ends %q", where, secret, lastBytes(text, 200))
		}
	}
}

// TestCheckTailCarriesNoSecrets is the report: a check prints a database's address with its password
// in it, and the log says `postgres://[redacted]@db/orbit` while the result's tail, which the control
// plane stores on the job and the item and quotes to the coordinator, had the password whole.
func TestCheckTailCarriesNoSecrets(t *testing.T) {
	prints := "printf 'dial " + tailAddress + " with " + tailToken + "\\n'; "

	t.Run("a failed check on a v2 claim", func(t *testing.T) {
		r := repoWithOneTask(t)
		result, chunks := reportedJob(t, tailToken, v2Job(r, "task/one", "project/line", IntegrationCheckSpec{
			Name:           "MERGE_CHECK",
			Command:        prints + "exit 1",
			TimeoutSeconds: 60,
		}))
		if result.State != "CHECK_FAILED" {
			t.Fatalf("state = %s, want CHECK_FAILED", result.State)
		}
		tail, log := result.Checks[0].OutputTail, logOf(t, chunks, 1)
		assertNoSecretLeft(t, "the tail", tail, tailPassword, tailToken)
		assertNoSecretLeft(t, "the log", log, tailPassword, tailToken)
		want := "dial " + tailRedacted + " with " + integrationOutputRedacted + "\n"
		if tail != want || log != want {
			t.Errorf("the tail = %q and the log = %q, want both to read %q", tail, log, want)
		}
	})

	t.Run("a check that passed", func(t *testing.T) {
		// Its tail is stored on the job row and on the candidate's approval card all the same.
		r := repoWithOneTask(t)
		result, _ := reportedJob(t, tailToken, v2Job(r, "task/one", "project/line", IntegrationCheckSpec{
			Name:           "MERGE_CHECK",
			Command:        prints + "exit 0",
			TimeoutSeconds: 60,
		}))
		if result.State != "LANDED" {
			t.Fatalf("state = %s, want LANDED", result.State)
		}
		assertNoSecretLeft(t, "the tail", result.Checks[0].OutputTail, tailPassword, tailToken)
	})

	t.Run("a legacy claim, with an environment credential", func(t *testing.T) {
		t.Setenv("ORBIT_DRILL_PASSWORD", "an-env-secret-value")
		r := repoWithOneTask(t)
		result, _ := reportedJob(t, "tok", r.command("task/one", "project/line", IntegrationCheckSpec{
			Name:           "MERGE_CHECK",
			Command:        "printf 'dial " + tailAddress + " as %s\\n' \"$ORBIT_DRILL_PASSWORD\"; exit 1",
			TimeoutSeconds: 60,
		}))
		assertNoSecretLeft(t, "the tail", result.Checks[0].OutputTail, tailPassword, "an-env-secret-value")
	})

	t.Run("a check run with no claim behind it", func(t *testing.T) {
		// The door merge recovery's check goes through.
		dir := t.TempDir()
		result := runIntegrationCheck(dir, IntegrationCheckSpec{
			Name:           "merge",
			Command:        prints + "exit 1",
			TimeoutSeconds: 60,
		})
		assertNoSecretLeft(t, "the tail", result.OutputTail, tailPassword)
	})
}

// TestCheckTailCutInsideASecret: the tail is the last 16 KB of the output and that boundary falls
// anywhere, so it falls inside an address too. Clipped first and redacted after, what it leaves is the
// back half of a password with no scheme in front of it for any rule to recognise.
func TestCheckTailCutInsideASecret(t *testing.T) {
	t.Setenv("ORBIT_DRILL_TOKEN", tailToken)
	cases := []struct {
		name, printed, secret, after string
	}{
		{name: "an address's password", printed: tailAddress, secret: tailPassword, after: "@db/orbit"},
		{name: "a credential from the environment", printed: "token " + tailToken, secret: tailToken},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			at := strings.Index(tc.printed, tc.secret)
			// Every place the window can start, from the front of what was printed to the last few
			// bytes of the secret.
			for start := 0; start < at+len(tc.secret)-3; start++ {
				dir := t.TempDir()
				output := "first line\n" + tc.printed + strings.Repeat("x", resultTailMax-len(tc.printed)+start)
				if err := os.WriteFile(filepath.Join(dir, "printed"), []byte(output), 0o644); err != nil {
					t.Fatalf("write the output: %v", err)
				}
				tail := runIntegrationCheck(dir, IntegrationCheckSpec{
					Name:           "MERGE_CHECK",
					Command:        "cat printed; exit 1",
					TimeoutSeconds: 60,
				}).OutputTail
				rest := tc.secret
				if start > at {
					rest = tc.secret[start-at:]
				}
				if strings.Contains(tail, rest+tc.after) {
					t.Fatalf("with the window starting %d bytes into %q, the tail still holds %q: it starts %q",
						start, tc.printed, rest, tail[:min(len(tail), 80)])
				}
			}
		})
	}
}

// TestRecipeFailureCarriesNoSecrets: the tree's recipe has no tail of its own, but a recipe that fails
// says why through the end of its output, and that goes into the error detail the item stores and the
// coordinator's turn quotes.
func TestRecipeFailureCarriesNoSecrets(t *testing.T) {
	r := repoWithOneTask(t)
	r.checkout("task/one")
	r.writeIn(integrationPrepareScript, "printf 'dial "+tailAddress+"\\n'\nexit 1\n")
	r.commit("a recipe that cannot reach its database")
	r.push("task/one")
	r.checkout("main")
	result, chunks := reportedJob(t, tailToken, v2Job(r, "task/one", "project/line", IntegrationCheckSpec{
		Name:           "MERGE_CHECK",
		Command:        "exit 0",
		TimeoutSeconds: 60,
	}))
	if result.State != "ERROR" || result.ErrorCode != "CHECK_TREE_UNPREPARED" {
		t.Fatalf("state = %s / %s, want ERROR / CHECK_TREE_UNPREPARED", result.State, result.ErrorCode)
	}
	detail, err := json.Marshal(result.ErrorDetail)
	if err != nil {
		t.Fatalf("marshal the detail: %v", err)
	}
	assertNoSecretLeft(t, "the error detail", string(detail), tailPassword)
	if !strings.Contains(string(detail), tailRedacted) {
		t.Errorf("the error detail = %s, want it to say which address failed, redacted", detail)
	}
	assertNoSecretLeft(t, "the log", logOf(t, chunks, 1), tailPassword)
}

// uploadedAs runs one command's output through a real uploader, to its end, sending through send.
func uploadedAs(t *testing.T, redactor *integrationOutputRedactor, chunkBytes int, send integrationOutputSender, writes ...string) {
	t.Helper()
	uploader := newIntegrationLogUploader(context.Background(), IntegrationJobCommand{
		outputSender:     send,
		outputEvery:      time.Hour,
		outputChunkBytes: chunkBytes,
		outputRedactor:   redactor,
	})
	out := newIntegrationOutput()
	uploader.attach(out, IntegrationJobOutputCheck{Name: "MERGE_CHECK", Index: 1})
	for _, write := range writes {
		if _, err := out.Write([]byte(write)); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	out.closeSink()
	uploader.close()
}

// TestIntegrationOutputCarriesOnPastAChunkItCouldNotDeliver: a chunk refused for anything but the
// claim being gone costs the log that chunk. The line this logs always said "carrying on", and the
// drain returned: every chunk after it, of the same flush, was never sent.
func TestIntegrationOutputCarriesOnPastAChunkItCouldNotDeliver(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"a 500 from the control plane", &transportHTTPError{statusCode: http.StatusInternalServerError}},
		{"a refusal of the chunk itself", &transportHTTPError{statusCode: http.StatusBadRequest}},
		{"a connection that broke", errors.New("connection reset by peer")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var sent []IntegrationJobOutputRequest
			send := func(_ context.Context, req IntegrationJobOutputRequest) error {
				mu.Lock()
				defer mu.Unlock()
				if req.Seq == 1 {
					return tc.err
				}
				sent = append(sent, req)
				return nil
			}
			uploadedAs(t, urlOnlyRedactor(), 4, send, "aaaabbbbccccdddd")
			var got []string
			for _, chunk := range sent {
				got = append(got, chunk.Text)
			}
			if strings.Join(got, "|") != "aaaa|cccc|dddd" {
				t.Fatalf("the chunks that arrived = %v, want every one but the second", got)
			}
			if seqs := outputSeqs(sent); seqs[1] != 2 || seqs[2] != 3 {
				t.Fatalf("seqs = %v, want each chunk under the seq it was numbered with", seqs)
			}
		})
	}
}

// TestIntegrationOutputCarriesOnOverTheRealTransport: the same, with the refusal the control plane
// really answered with (a 500 over HTTP, read by the transport the runner really sends through), and
// with the refusal that does mean stop right beside it.
func TestIntegrationOutputCarriesOnOverTheRealTransport(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		want   string
	}{
		{"a 500 passes over that chunk", http.StatusInternalServerError, "aaaa|cccc|dddd"},
		{"a 409 stops the upload", http.StatusConflict, "aaaa"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var stored []string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body IntegrationJobOutputRequest
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body.Seq == 1 {
					w.WriteHeader(tc.status)
					_, _ = w.Write([]byte(`{"statusCode":` + strconv.Itoa(tc.status) + `}`))
					return
				}
				mu.Lock()
				stored = append(stored, body.Text)
				mu.Unlock()
				_, _ = w.Write([]byte(`{"accepted":true}`))
			}))
			defer srv.Close()
			transport := NewTransport(srv.URL, "tok")
			send := func(ctx context.Context, req IntegrationJobOutputRequest) error {
				return transport.integrationJobOutput(ctx, "the-job", req)
			}
			uploadedAs(t, urlOnlyRedactor(), 4, send, "aaaabbbbccccdddd")
			mu.Lock()
			defer mu.Unlock()
			if got := strings.Join(stored, "|"); got != tc.want {
				t.Fatalf("the control plane stored %q, want %q", got, tc.want)
			}
		})
	}
}

// TestIntegrationOutputEndsAFlushWhoseBudgetIsSpent: the budget a flush has is what keeps a dead
// control plane from holding a check's end, so a send that used it up is the last one tried: every one
// after it would fail at once, on the same expired context.
func TestIntegrationOutputEndsAFlushWhoseBudgetIsSpent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu sync.Mutex
	attempts := 0
	uploader := newIntegrationLogUploader(ctx, IntegrationJobCommand{
		outputSender: func(sendCtx context.Context, _ IntegrationJobOutputRequest) error {
			mu.Lock()
			attempts++
			mu.Unlock()
			cancel()
			<-sendCtx.Done()
			return sendCtx.Err()
		},
		outputEvery:      time.Hour,
		outputChunkBytes: 4,
		outputRedactor:   urlOnlyRedactor(),
	})
	out := newIntegrationOutput()
	uploader.attach(out, IntegrationJobOutputCheck{Name: "MERGE_CHECK", Index: 1})
	if _, err := out.Write([]byte("aaaabbbbccccdddd")); err != nil {
		t.Fatalf("write: %v", err)
	}
	out.closeSink()
	uploader.close()
	mu.Lock()
	defer mu.Unlock()
	if attempts != 1 {
		t.Fatalf("the uploader tried %d sends once its budget was spent, want the one that spent it", attempts)
	}
}

// TestIntegrationOutputTakesNulOut: PostgreSQL's text holds no NUL, so the control plane refused a
// chunk carrying one. The runner does not depend on which of the two was updated first, and a secret
// a NUL happens to sit inside (a UTF-16 dump is one in every other byte) is recognised as what it is.
func TestIntegrationOutputTakesNulOut(t *testing.T) {
	var mu sync.Mutex
	var joined strings.Builder
	send := func(_ context.Context, req IntegrationJobOutputRequest) error {
		mu.Lock()
		defer mu.Unlock()
		joined.WriteString(req.Text)
		return nil
	}
	uploadedAs(t, newIntegrationOutputRedactor(tailToken), 16, send,
		"before\x00after\n", "token the-runners-secret\x00-token-0123456789\n", "p\x00o\x00s\x00t\x00g\x00r\x00e\x00s\x00://app:pw@db\n")
	want := "beforeafter\ntoken " + integrationOutputRedacted + "\npostgres://[redacted]@db\n"
	if joined.String() != want {
		t.Fatalf("the upload = %q, want %q", joined.String(), want)
	}
}

// TestIntegrationOutputURLRuleIsTheControlPlanes: the rule here and the rule at the control plane's
// door (src/apiserver/src/runner-api/check-output-redaction.ts) answer one table, which that door's
// spec reads too. Neither can move alone.
func TestIntegrationOutputURLRuleIsTheControlPlanes(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "integration-url-credentials.json"))
	if err != nil {
		t.Fatalf("read the table: %v", err)
	}
	var table struct {
		Redacted []struct {
			Text string `json:"text"`
			Want string `json:"want"`
		} `json:"redacted"`
		Unchanged []string `json:"unchanged"`
	}
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatalf("parse the table: %v", err)
	}
	if len(table.Redacted) == 0 || len(table.Unchanged) == 0 {
		t.Fatalf("the table is empty: %+v", table)
	}
	redactor := urlOnlyRedactor()
	for _, tc := range table.Redacted {
		if got := redactor.redact(tc.Text); got != tc.Want {
			t.Errorf("redact(%q) = %q, want %q", tc.Text, got, tc.Want)
		}
	}
	for _, text := range table.Unchanged {
		if got := redactor.redact(text); got != text {
			t.Errorf("redact(%q) = %q, want it unchanged", text, got)
		}
	}
}
