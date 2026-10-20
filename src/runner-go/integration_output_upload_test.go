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
//     the environment, and the userinfo of a URL of any scheme (a git remote's, a database's), even
//     when the address arrives split across two writes;
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

// urlOnlyRedactor holds no secret at all — carry 0, as in the merge check's stripped environment —
// so the URL rule is the only thing between an address and the control plane.
func urlOnlyRedactor() *integrationOutputRedactor {
	return &integrationOutputRedactor{urlCredential: integrationURLCredential}
}

// TestIntegrationOutputRedactsTheUserinfoOfAnyScheme: a URL's userinfo is a credential whatever the
// scheme in front of it. A check prints a database's, a cache's or a broker's address as readily as
// a git remote's, and a rule that named only https, ftp and ssh let every one of those through whole.
// The git remotes come out exactly as they always did: the userinfo, a bare token or user included,
// becomes the marker and the scheme and host stay.
func TestIntegrationOutputRedactsTheUserinfoOfAnyScheme(t *testing.T) {
	redactor := urlOnlyRedactor()
	for _, tc := range []struct{ name, text, want, leak string }{
		{"postgres", "dial postgres://app:s3cretPass@db.internal:5432/orders failed",
			"dial postgres://[redacted]@db.internal:5432/orders failed", "s3cretPass"},
		{"postgresql in an assignment", "DATABASE_URL=postgresql://app:s3cretPass@db/orders",
			"DATABASE_URL=postgresql://[redacted]@db/orders", "s3cretPass"},
		{"mysql", "mysql://root:myPw0rd99@127.0.0.1:3306/app",
			"mysql://[redacted]@127.0.0.1:3306/app", "myPw0rd99"},
		{"redis with no user", "redis://:cachePass99@cache:6379/0",
			"redis://[redacted]@cache:6379/0", "cachePass99"},
		{"rediss with a user", "rediss://default:cachePass99@cache:6380",
			"rediss://[redacted]@cache:6380", "cachePass99"},
		{"amqp", "amqp://guest:brokerPw77@mq:5672/vhost",
			"amqp://[redacted]@mq:5672/vhost", "brokerPw77"},
		{"mongodb+srv", "mongodb+srv://admin:mongoPw42@cluster0.example.invalid/db?retryWrites=true",
			"mongodb+srv://[redacted]@cluster0.example.invalid/db?retryWrites=true", "mongoPw42"},
		{"jdbc's inner scheme", "jdbc:postgresql://app:s3cretPass@db:5432/orders",
			"jdbc:postgresql://[redacted]@db:5432/orders", "s3cretPass"},
		{"upper case", "S3://KEYID:Sekr1tValue@bucket/key",
			"S3://[redacted]@bucket/key", "Sekr1tValue"},
		{"after a word character", "url_postgres://app:s3cretPass@db",
			"url_postgres://[redacted]@db", "s3cretPass"},
		{"git https remote", "fatal: could not read https://bob:hunter2pass@example.invalid/repo.git",
			"fatal: could not read https://[redacted]@example.invalid/repo.git", "hunter2pass"},
		{"git https token alone", "remote: https://ghp_tokenvalue0123@example.invalid/o/r.git",
			"remote: https://[redacted]@example.invalid/o/r.git", "ghp_tokenvalue0123"},
		{"git ssh user", "ssh://git@example.invalid/o/r.git",
			"ssh://[redacted]@example.invalid/o/r.git", "ssh://git@"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := redactor.redact(tc.text)
			if got != tc.want {
				t.Fatalf("redact(%q) = %q, want %q", tc.text, got, tc.want)
			}
			if strings.Contains(got, tc.leak) {
				t.Fatalf("redact(%q) still carries %q", tc.text, tc.leak)
			}
		})
	}
}

// TestIntegrationOutputLeavesTextWithoutUserinfoAlone: an `@` that is not a URL's userinfo, and an
// address that has no userinfo, are not a credential and come out as they went in.
func TestIntegrationOutputLeavesTextWithoutUserinfoAlone(t *testing.T) {
	redactor := urlOnlyRedactor()
	for _, text := range []string{
		"mail someone@example.invalid about it",
		"git@example.invalid:owner/repo.git",
		"go: downloading golang.org/x/mod@v0.17.0",
		"see https://example.invalid/pkg@v1.2.3 and https://registry.example.invalid/@scope/pkg",
		"postgres://db.internal:5432/orders",
		"https://example.invalid:8443/path",
		"ws://localhost:8080/socket?user=a@b",
		"a:// b@c, 3://4@5 and http://@host/path",
		"the build took 3:04 on user@host",
	} {
		if got := redactor.redact(text); got != text {
			t.Fatalf("redact(%q) = %q, want it unchanged", text, got)
		}
	}
}

// TestIntegrationOutputRedactsAnAddressSplitAcrossTwoChunks: the uploader streams, so an address can
// arrive in two writes with a flush between them — the cut inside the scheme, inside the user or the
// password, right before or right after the `@`. Every one of those cuts comes out exactly as the
// whole text redacted at once: nothing of the userinfo leaves early, nothing is sent twice and
// nothing is lost. It holds with no secret in the environment (carry 0), where only the address's own
// hold-back protects it, and with a secret whose carry is shorter than the address.
func TestIntegrationOutputRedactsAnAddressSplitAcrossTwoChunks(t *testing.T) {
	redactors := []struct {
		name string
		new  func() *integrationOutputRedactor
	}{
		{"no secrets", urlOnlyRedactor},
		{"a short secret", func() *integrationOutputRedactor {
			return &integrationOutputRedactor{secrets: []string{"unrelated-0123"}, urlCredential: integrationURLCredential}
		}},
	}
	lines := []struct{ text, scheme, password string }{
		{"connecting to postgres://app:s3cretPass@db.internal:5432/orders now\n", "postgres://", "s3cretPass"},
		{"redis://:cachePass99@cache:6379/0\n", "redis://", "cachePass99"},
		{"fatal: could not read https://x-access-token:ghs_tok3nvalue@example.invalid/o/r.git\n", "https://", "ghs_tok3nvalue"},
		{"token unrelated-0123 then amqp://guest:brokerPw77@mq:5672/vhost\n", "amqp://", "brokerPw77"},
	}
	for _, r := range redactors {
		for _, line := range lines {
			want := r.new().redact(line.text)
			if strings.Contains(want, line.password) {
				t.Fatalf("%s: the one-shot redaction of %q still carries the password: %q", r.name, line.text, want)
			}
			start := strings.Index(line.text, line.scheme)
			at := start + strings.Index(line.text[start:], "@")
			for split := 1; split < len(line.text); split++ {
				first, second := line.text[:split], line.text[split:]
				early, whole := streamTwoChunks(t, r.new(), first, second)
				if whole != want {
					t.Fatalf("%s: %q + %q uploaded %q, want the one-shot redaction %q", r.name, first, second, whole, want)
				}
				if strings.Contains(early, line.password) || !strings.HasPrefix(want, early) {
					t.Fatalf("%s: %q + %q: the mid-command flush sent %q, not a prefix of %q", r.name, first, second, early, want)
				}
				// The address is held back from its scheme on, and only from there: what came before
				// it is not kept off the page along with it.
				if r.name == "no secrets" && split >= start && split <= at && early != line.text[:start] {
					t.Fatalf("%s: %q + %q: the mid-command flush sent %q, want %q", r.name, first, second, early, line.text[:start])
				}
			}
		}
	}
}

// TestIntegrationOutputBoundsTheHoldBackOfAnUnfinishedAddress: what an address whose `@` has not
// arrived holds back is capped like a secret's carry. A long run that reads like the start of an
// address must not keep a check's output off the page until the command ends.
func TestIntegrationOutputBoundsTheHoldBackOfAnUnfinishedAddress(t *testing.T) {
	text := "x://" + strings.Repeat("a", 4*integrationOutputCarryMax)
	early, whole := streamTwoChunks(t, urlOnlyRedactor(), text, "\n")
	if held := len(text) - len(early); held > integrationOutputCarryMax {
		t.Fatalf("the mid-command flush held back %d bytes, want at most %d", held, integrationOutputCarryMax)
	}
	if whole != text+"\n" {
		t.Fatalf("uploaded %d bytes, want the %d written", len(whole), len(text)+1)
	}
}

// streamTwoChunks writes first, flushes the way the timer does while a command runs, writes second
// and ends the command. It answers what that mid-command flush sent and the whole upload, and checks
// the seq numbering on the way. Neither the timer nor a full buffer flushes on its own here, so the
// one flush in the middle is the only boundary.
func streamTwoChunks(t *testing.T, redactor *integrationOutputRedactor, first, second string) (early, whole string) {
	t.Helper()
	recorder := &outputRecorder{}
	uploader := newIntegrationLogUploader(context.Background(), IntegrationJobCommand{
		outputSender:     recorder.send,
		outputEvery:      time.Hour,
		outputChunkBytes: 1 << 20,
		outputRedactor:   redactor,
	})
	out := newIntegrationOutput()
	uploader.attach(out, IntegrationJobOutputCheck{Name: "TASK_ACCEPTANCE", Index: 1})
	if _, err := out.Write([]byte(first)); err != nil {
		t.Fatalf("write: %v", err)
	}
	uploader.drain(nil, false)
	var b strings.Builder
	for _, chunk := range recorder.snapshot() {
		b.WriteString(chunk.Text)
	}
	early = b.String()
	if _, err := out.Write([]byte(second)); err != nil {
		t.Fatalf("write: %v", err)
	}
	uploader.Close()
	uploader.close()
	chunks := recorder.snapshot()
	if seqs := outputSeqs(chunks); !seqsContiguousFromZero(seqs) {
		t.Fatalf("seqs = %v, want 0..n-1", seqs)
	}
	b.Reset()
	for _, chunk := range chunks {
		b.WriteString(chunk.Text)
	}
	return early, b.String()
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
