//go:build linux || darwin

package main

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// The upload side of a check's output (contract §2.2 J-T4's output route, §2.9 LS2, design
// docs/landing-session-design.md §8 phase 3):
//   * a check's output is uploaded in ordered chunks, under the check it belongs to and under the
//     claim the report carries;
//   * the machine's own secrets never reach the control plane — the runner token, credentials in
//     the environment, and the userinfo of a git remote URL;
//   * a refused claim stops the uploader instead of retrying into it;
//   * a legacy claim uploads nothing and keeps the 16 KB tail its result always carried.

// outputRecorder is a sender that keeps what it was sent.
type outputRecorder struct {
	mu      sync.Mutex
	chunks  []IntegrationJobOutputRequest
	fail    error
	blocked int
}

func (r *outputRecorder) send(_ context.Context, req IntegrationJobOutputRequest) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail != nil {
		r.blocked++
		return r.fail
	}
	r.chunks = append(r.chunks, req)
	return nil
}

func (r *outputRecorder) snapshot() []IntegrationJobOutputRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]IntegrationJobOutputRequest(nil), r.chunks...)
}

func (r *outputRecorder) attempts() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.chunks) + r.blocked
}

// TestIntegrationOutputUploadsItsChunksInOrder: the chunks of one check leave in the order they
// were written, with a contiguous seq from 0, and a second command under the SAME check continues
// the numbering rather than starting it over (the tree's recipe and check 1 share one log).
func TestIntegrationOutputUploadsItsChunksInOrder(t *testing.T) {
	recorder := &outputRecorder{}
	uploader := newIntegrationLogUploader(context.Background(), IntegrationJobCommand{
		outputSender:     recorder.send,
		outputEvery:      5 * time.Millisecond,
		outputChunkBytes: 8,
		outputRedactor:   newIntegrationOutputRedactor(),
	})
	out := newIntegrationOutput()
	uploader.attach(out, IntegrationJobOutputCheck{Name: "MERGE_CHECK", Index: 2})
	if _, err := out.Write([]byte("hello ")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := out.Write([]byte("world, this is a longer piece of output")); err != nil {
		t.Fatalf("write: %v", err)
	}
	uploader.Close()
	// The same check again, as check 1 follows the tree's recipe: seq continues.
	uploader.attach(out, IntegrationJobOutputCheck{Name: "MERGE_CHECK", Index: 2})
	if _, err := out.Write([]byte("and then more")); err != nil {
		t.Fatalf("write: %v", err)
	}
	uploader.Close()
	uploader.close()

	chunks := recorder.snapshot()
	if len(chunks) < 3 {
		t.Fatalf("chunks = %d, want the output split", len(chunks))
	}
	var joined strings.Builder
	for i, chunk := range chunks {
		if chunk.Seq != i {
			t.Fatalf("chunk %d has seq %d, want the order written", i, chunk.Seq)
		}
		if chunk.Check.Name != "MERGE_CHECK" || chunk.Check.Index != 2 {
			t.Fatalf("chunk %d names check %+v, want MERGE_CHECK 2", i, chunk.Check)
		}
		joined.WriteString(chunk.Text)
	}
	if got, want := joined.String(), "hello world, this is a longer piece of outputand then more"; got != want {
		t.Fatalf("uploaded text = %q, want %q", got, want)
	}
}

// TestIntegrationOutputFlushesWhenTheRedactorHoldsNoSecret: a runner whose environment holds no
// credential (carry 0, as in the merge check's stripped environment) still flushes pending output —
// on the timer, and on a full buffer. The hold-back cut used to run regardless and read
// text[len(text)], panicking the uploader's goroutine and with it the whole process.
func TestIntegrationOutputFlushesWhenTheRedactorHoldsNoSecret(t *testing.T) {
	noSecrets := func(t *testing.T) *integrationOutputRedactor {
		t.Helper()
		redactor := &integrationOutputRedactor{urlCredential: integrationURLCredential}
		if carry := redactor.carry(); carry != 0 {
			t.Fatalf("carry = %d, want 0 for a redactor with no secrets", carry)
		}
		return redactor
	}
	joined := func(recorder *outputRecorder) string {
		var b strings.Builder
		for _, chunk := range recorder.snapshot() {
			b.WriteString(chunk.Text)
		}
		return b.String()
	}

	t.Run("ticker", func(t *testing.T) {
		recorder := &outputRecorder{}
		uploader := newIntegrationLogUploader(context.Background(), IntegrationJobCommand{
			outputSender:     recorder.send,
			outputEvery:      5 * time.Millisecond,
			outputChunkBytes: 4096,
			outputRedactor:   noSecrets(t),
		})
		out := newIntegrationOutput()
		uploader.attach(out, IntegrationJobOutputCheck{Name: "MERGE_CHECK", Index: 1})
		if _, err := out.Write([]byte("a quiet check's only line\n")); err != nil {
			t.Fatalf("write: %v", err)
		}
		waitForOutputChunks(t, recorder, 1)
		uploader.Close()
		uploader.close()
		if got, want := joined(recorder), "a quiet check's only line\n"; got != want {
			t.Fatalf("uploaded text = %q, want %q", got, want)
		}
	})

	t.Run("kick", func(t *testing.T) {
		recorder := &outputRecorder{}
		uploader := newIntegrationLogUploader(context.Background(), IntegrationJobCommand{
			outputSender:     recorder.send,
			outputEvery:      time.Hour, // only a full buffer can flush this one
			outputChunkBytes: 8,
			outputRedactor:   noSecrets(t),
		})
		out := newIntegrationOutput()
		uploader.attach(out, IntegrationJobOutputCheck{Name: "MERGE_CHECK", Index: 1})
		if _, err := out.Write([]byte("kick-flushed output\n")); err != nil {
			t.Fatalf("write: %v", err)
		}
		waitForOutputChunks(t, recorder, 1)
		uploader.Close()
		uploader.close()
		if got, want := joined(recorder), "kick-flushed output\n"; got != want {
			t.Fatalf("uploaded text = %q, want %q", got, want)
		}
	})
}

// waitForOutputChunks waits until the sender has taken at least want chunks.
func waitForOutputChunks(t *testing.T, recorder *outputRecorder, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(recorder.snapshot()) >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("uploader sent %d chunks, want at least %d", len(recorder.snapshot()), want)
}

// TestIntegrationOutputRedactsTheRunnersSecrets: the runner token this process holds, a credential
// in the environment, and the userinfo of a git remote URL are all redacted before a chunk leaves
// the machine — including a secret split across two writes, which the uploader holds back rather
// than sending half of.
func TestIntegrationOutputRedactsTheRunnersSecrets(t *testing.T) {
	t.Setenv("ORBIT_USER_TOKEN", "env-user-token-0123456789")
	runnerToken := "runner-token-abcdef0123456789"
	redactor := newIntegrationOutputRedactor(runnerToken)

	line := "fatal: could not read https://bob:hunter2pass@example.invalid/repo.git\n"
	line += "token=" + runnerToken + " other=" + "env-user-token-0123456789" + "\n"
	redacted := redactor.redact(line)
	for _, leak := range []string{runnerToken, "env-user-token-0123456789", "hunter2pass"} {
		if strings.Contains(redacted, leak) {
			t.Fatalf("redacted text still carries %q: %q", leak, redacted)
		}
	}
	if !strings.Contains(redacted, integrationOutputRedacted) {
		t.Fatalf("redacted text = %q, want the marker", redacted)
	}

	recorder := &outputRecorder{}
	uploader := newIntegrationLogUploader(context.Background(), IntegrationJobCommand{
		outputSender:     recorder.send,
		outputEvery:      5 * time.Millisecond,
		outputChunkBytes: 4096,
		outputRedactor:   redactor,
	})
	out := newIntegrationOutput()
	uploader.attach(out, IntegrationJobOutputCheck{Name: "TASK_ACCEPTANCE", Index: 1})
	// Half a token in one write and the rest in another: the carry keeps the prefix off the wire
	// until the whole secret has arrived.
	if _, err := out.Write([]byte("prefix " + runnerToken[:len(runnerToken)/2])); err != nil {
		t.Fatalf("write: %v", err)
	}
	time.Sleep(30 * time.Millisecond)
	for _, chunk := range recorder.snapshot() {
		if strings.Contains(chunk.Text, runnerToken[:len(runnerToken)/2]) {
			t.Fatalf("half a secret reached the control plane: %q", chunk.Text)
		}
	}
	if _, err := out.Write([]byte(runnerToken[len(runnerToken)/2:] + " suffix\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	uploader.Close()
	uploader.close()
	var joined strings.Builder
	for _, chunk := range recorder.snapshot() {
		joined.WriteString(chunk.Text)
	}
	if strings.Contains(joined.String(), runnerToken) {
		t.Fatalf("the concatenated upload carries the runner token: %q", joined.String())
	}
	if !strings.Contains(joined.String(), integrationOutputRedacted) {
		t.Fatalf("the upload = %q, want the redaction marker", joined.String())
	}
}

// TestIntegrationOutputStopsOnARefusedClaim: 409 STALE_CLAIM / ALREADY_FINAL and 404 mean the claim
// is gone. The uploader stops instead of retrying into a claim that can never be written again.
func TestIntegrationOutputStopsOnARefusedClaim(t *testing.T) {
	recorder := &outputRecorder{fail: &transportHTTPError{statusCode: http.StatusConflict}}
	uploader := newIntegrationLogUploader(context.Background(), IntegrationJobCommand{
		outputSender:     recorder.send,
		outputEvery:      5 * time.Millisecond,
		outputChunkBytes: 4,
		outputRedactor:   newIntegrationOutputRedactor(),
	})
	out := newIntegrationOutput()
	uploader.attach(out, IntegrationJobOutputCheck{Name: "MERGE_CHECK", Index: 1})
	if _, err := out.Write([]byte("this output will be refused")); err != nil {
		t.Fatalf("write: %v", err)
	}
	time.Sleep(40 * time.Millisecond)
	if _, err := out.Write([]byte("and so will this")); err != nil {
		t.Fatalf("write: %v", err)
	}
	uploader.Close()
	uploader.close()
	if attempts := recorder.attempts(); attempts > 1 {
		t.Fatalf("the uploader tried %d times after a refused claim, want one", attempts)
	}
}

// TestLegacyClaimUploadsNothingAndKeepsTheTail: a legacy claim has no output sender, so nothing is
// uploaded, and its result still carries exactly the last 16 KB of what the check printed.
func TestLegacyClaimUploadsNothingAndKeepsTheTail(t *testing.T) {
	if integrationOutputTail != 16*1024 {
		t.Fatalf("integrationOutputTail = %d, want 16 KiB", integrationOutputTail)
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/tail", "main")
	r.write("tail.txt", "the task's work\n")
	r.commit("task work")
	r.push("task/tail")
	r.checkout("main")

	check := IntegrationCheckSpec{
		Name: "TASK_ACCEPTANCE",
		// 64 KiB of 'a' followed by a marker: the tail must be the marker and the bytes before it,
		// and the uploader must not run at all.
		Command:          "head -c 65536 /dev/zero | tr '\\0' 'a'; printf 'THE-END'",
		ExpectedExitCode: 0,
		TimeoutSeconds:   60,
	}
	job := r.command("task/tail", "project/line", check)
	cp := &progressControlPlane{}
	srv := cp.serve(t)
	runIntegrationJobAndReport(context.Background(), context.Background(), NewTransport(srv.URL, "tok"), job)

	if outputs := cp.outputSnapshot(); len(outputs) != 0 {
		t.Fatalf("a legacy claim uploaded %d chunks, want none", len(outputs))
	}
	_, _, results, _ := cp.snapshot()
	if len(results) != 1 || results[0].State != "LANDED" {
		t.Fatalf("results = %+v, want one LANDED", results)
	}
	if len(results[0].Checks) != 1 {
		t.Fatalf("checks = %+v, want one", results[0].Checks)
	}
	tail := results[0].Checks[0].OutputTail
	if len(tail) != integrationOutputTail {
		t.Fatalf("tail is %d bytes, want exactly %d", len(tail), integrationOutputTail)
	}
	if !strings.HasSuffix(tail, "THE-END") {
		t.Fatalf("tail does not end with the command's last bytes: %q", tail[len(tail)-20:])
	}
	if strings.Trim(tail[:len(tail)-len("THE-END")], "a") != "" {
		t.Fatalf("tail carries something other than the command's output")
	}
}

// TestV2ClaimUploadsTheChecksOutputUnderItsClaim: a v2 claim streams the check's output, every
// chunk carrying the claim generation and lease owner — the fence the control plane writes it
// under — and the runner's own token is not among the bytes it sends.
func TestV2ClaimUploadsTheChecksOutputUnderItsClaim(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/stream", "main")
	r.write("stream.txt", "the task's work\n")
	r.commit("task work")
	r.push("task/stream")
	r.checkout("main")

	runnerToken := "the-runners-secret-token-0123456789"
	check := IntegrationCheckSpec{
		Name:             "TASK_ACCEPTANCE",
		Command:          "printf 'first line\\n'; printf 'token=%s\\n' " + runnerToken + "; printf 'last line\\n'",
		ExpectedExitCode: 0,
		TimeoutSeconds:   60,
	}
	job := v2Job(r, "task/stream", "project/line", check)
	job.outputEvery = 10 * time.Millisecond
	job.outputChunkBytes = 16
	job.outputRedactor = newIntegrationOutputRedactor(runnerToken)
	cp := &progressControlPlane{}
	srv := cp.serve(t)
	job.outputSender = func(ctx context.Context, req IntegrationJobOutputRequest) error {
		req.ClaimGeneration = job.ClaimGeneration
		req.LeaseOwner = job.LeaseOwner
		return NewTransport(srv.URL, runnerToken).integrationJobOutput(ctx, job.JobID, req)
	}
	runIntegrationJobAndReport(context.Background(), context.Background(), NewTransport(srv.URL, runnerToken), job)

	outputs := cp.outputSnapshot()
	if len(outputs) == 0 {
		t.Fatal("a v2 claim uploaded nothing")
	}
	var joined strings.Builder
	for _, chunk := range outputs {
		if chunk.ClaimGeneration != "1" || chunk.LeaseOwner != "the-process" {
			t.Fatalf("chunk carries claim (%q, %q), want the report's fence", chunk.ClaimGeneration, chunk.LeaseOwner)
		}
		if chunk.Check.Name != "TASK_ACCEPTANCE" || chunk.Check.Index != 1 {
			t.Fatalf("chunk names check %+v, want TASK_ACCEPTANCE 1", chunk.Check)
		}
		if strings.Contains(chunk.Text, runnerToken) {
			t.Fatalf("the runner token reached the control plane: %q", chunk.Text)
		}
		joined.WriteString(chunk.Text)
	}
	for _, want := range []string{"first line", "token=" + integrationOutputRedacted, "last line"} {
		if !strings.Contains(joined.String(), want) {
			t.Fatalf("uploaded text = %q, want it to contain %q", joined.String(), want)
		}
	}
	if seqs := outputSeqs(outputs); !seqsContiguousFromZero(seqs) {
		t.Fatalf("seqs = %v, want 0..n-1", seqs)
	}
}

func outputSeqs(chunks []IntegrationJobOutputRequest) []int {
	seqs := make([]int, 0, len(chunks))
	for _, chunk := range chunks {
		seqs = append(seqs, chunk.Seq)
	}
	return seqs
}

func seqsContiguousFromZero(seqs []int) bool {
	for i, seq := range seqs {
		if seq != i {
			return false
		}
	}
	return true
}
