//go:build linux || darwin

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"orbit/linkpb"
)

// The control plane asks for a job's newest lines over the link (BackgroundJobTailRequest), and the runner answers
// from the job's output file: the last lines, at most 40, without colour codes, for a running job and for one that has
// ended while its session is still here; NOT_FOUND for a job or a session this process does not host.
func TestTheNewestLinesOfAJobAreReadOverTheLink(t *testing.T) {
	r, in := newLinkEventsRig(t)
	c := r.useLink(t)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	bg := newBgTailer(ctx, func(string, map[string]interface{}) {}, nil)
	t.Cleanup(bg.stopAll)
	const session = "0b8f3c1e-2a4d-4e5f-9a6b-7c8d9e0f1a2b"
	bgSessionServices.Store(session, &bgJobService{bg: bg})
	t.Cleanup(func() { bgSessionServices.Delete(session) })

	start := func(command string) bgJobStatus {
		t.Helper()
		st, err := bg.startJob(bgJobSpec{Command: command, Kind: bgKindJob, Dir: t.TempDir(), ScratchDir: t.TempDir()})
		if err != nil {
			t.Fatal(err)
		}
		return st
	}
	ask := func(id, sessionID, jobID string, maxLines uint32) *linkpb.BackgroundJobTailResponse {
		t.Helper()
		c.send(&linkpb.Frame{Body: &linkpb.Frame_BackgroundJobTailRequest{BackgroundJobTailRequest: &linkpb.BackgroundJobTailRequest{
			RequestId: id, SessionId: sessionID, JobId: jobID, MaxLines: maxLines, MaxBytes: 8192,
		}}})
		var got *linkpb.BackgroundJobTailResponse
		linkWaitFor(t, 5*time.Second, "the answer to "+id, func() bool {
			in.mu.Lock()
			defer in.mu.Unlock()
			for _, a := range in.tailAnswers {
				if a.GetRequestId() == id {
					got = a
					return true
				}
			}
			return false
		})
		if got.GetSessionId() != sessionID || got.GetJobId() != jobID {
			t.Fatalf("answered %+v", got)
		}
		return got
	}

	running := start(`for i in $(seq 1 60); do printf '\033[1;32mline %d\033[0m\n' "$i"; done; exec sleep 300`)
	awaitCondition(t, 10*time.Second, "the job never wrote its 60 lines", func() bool {
		data, _ := os.ReadFile(running.OutputPath)
		return strings.Contains(string(data), "line 60")
	})
	got := ask("tail-1", session, running.JobID, 100) // more than 40 is read as 40
	if got.GetOutcome() != linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_OK || got.GetStatus() != bgStatusRunning || got.GetExited() {
		t.Fatalf("running job answered %v %q exited=%v", got.GetOutcome(), got.GetStatus(), got.GetExited())
	}
	var want strings.Builder
	for i := 21; i <= 60; i++ {
		fmt.Fprintf(&want, "line %d\n", i)
	}
	if got.GetText() != want.String() {
		t.Errorf("the running job's tail is %q, want lines 21..60 without colour codes", got.GetText())
	}
	if !got.GetTruncated() || got.GetOutputBytes() == 0 {
		t.Errorf("truncated=%v outputBytes=%d, want older lines said to be left out of a non-empty file", got.GetTruncated(), got.GetOutputBytes())
	}
	if got := ask("tail-2", session, running.JobID, 3); got.GetText() != "line 58\nline 59\nline 60\n" {
		t.Errorf("three lines asked, got %q", got.GetText())
	}

	ended := start(`printf 'first\nsecond\nno newline yet'; exit 3`)
	awaitCondition(t, 10*time.Second, "the short job never ended", func() bool {
		st, _ := bg.jobStatus(ended.JobID)
		return st.Status != bgStatusRunning
	})
	got = ask("tail-3", session, ended.JobID, 40)
	if got.GetStatus() != bgStatusFailed || !got.GetExited() || got.GetExitCode() != 3 {
		t.Errorf("the ended job answered %q exited=%v code=%d, want failed with exit 3", got.GetStatus(), got.GetExited(), got.GetExitCode())
	}
	if got.GetText() != "first\nsecond\nno newline yet" || got.GetTruncated() {
		t.Errorf("the ended job's tail is %q truncated=%v", got.GetText(), got.GetTruncated())
	}

	for id, ids := range map[string][2]string{
		"tail-4": {session, "bgj_nosuchjob0"},
		"tail-5": {"5d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a", running.JobID},
	} {
		if got := ask(id, ids[0], ids[1], 40); got.GetOutcome() != linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_NOT_FOUND || got.GetText() != "" {
			t.Errorf("%s (session %s, job %s) answered %v %q, want NOT_FOUND", id, ids[0], ids[1], got.GetOutcome(), got.GetText())
		}
	}
}

// The text is held to its byte cap from the end, starting on a whole line where it can, and a read that began partway
// through the file drops the piece of a line it began in.
func TestTheOwnersTailIsHeldToItsCaps(t *testing.T) {
	long := strings.Repeat("x", 100)
	text, cut := ownerTailText(long+"\n"+long+"\nlast\n", false, 40, 120)
	if text != long+"\nlast\n" || !cut {
		t.Errorf("byte cap: got %q cut=%v", text, cut)
	}
	text, cut = ownerTailText("tial line\nwhole\n", true, 40, 8192)
	if text != "whole\n" || !cut {
		t.Errorf("a read from partway through: got %q cut=%v", text, cut)
	}
	text, cut = ownerTailText("a\r\nb\x00c\r\n", false, 40, 8192)
	if text != "a\nbc\n" || cut {
		t.Errorf("CRLF and NUL: got %q cut=%v", text, cut)
	}
	if text, cut := ownerTailText("", false, 40, 8192); text != "" || cut {
		t.Errorf("empty output: got %q cut=%v", text, cut)
	}
	if clampTail(0, 40) != 40 || clampTail(100, 40) != 40 || clampTail(5, 40) != 5 {
		t.Error("clampTail does not hold requests to [1, limit]")
	}
	// The file's end, and whether anything before it was left out.
	path := filepath.Join(t.TempDir(), "out")
	if err := os.WriteFile(path, []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}
	if raw, size, older := readOutputEnd(path, 4); raw != "6789" || size != 10 || !older {
		t.Errorf("readOutputEnd = %q %d %v", raw, size, older)
	}
	if raw, size, older := readOutputEnd(filepath.Join(t.TempDir(), "missing"), 4); raw != "" || size != 0 || older {
		t.Errorf("a missing file read %q %d %v", raw, size, older)
	}
}

// The runner declares the read under the name the control plane checks.
func TestTheRunnerDeclaresTheOwnersJobTail(t *testing.T) {
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+bgOutputTailCapabilityV1+",") {
		t.Fatalf("this runner does not declare %s: %q", bgOutputTailCapabilityV1, runnerCapabilitiesV1)
	}
	shared, err := os.ReadFile(filepath.Join("..", "shared", "src", "dto.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"BG_OUTPUT_TAIL_V1 = '" + bgOutputTailCapabilityV1 + "'",
		fmt.Sprintf("BG_JOB_TAIL_MAX_LINES = %d", bgOwnerTailMaxLines),
		"BG_JOB_TAIL_MAX_BYTES = 8 * 1024",
	} {
		if !strings.Contains(string(shared), want) {
			t.Errorf("@orbit/shared does not say %s", want)
		}
	}
}
