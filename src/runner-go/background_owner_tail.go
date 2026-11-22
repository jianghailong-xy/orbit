package main

import (
	"io"
	"strings"

	"orbit/linkpb"
)

// The newest lines of one bg_run job's output, for the job's card in the app while its owner has it
// on screen (GET /sessions/:id/background/jobs/:jobId/tail). The control plane asks over the runner
// link (BackgroundJobTailRequest, relayed by the gateway from a NATS request on rnr.<runnerId>) and
// this process answers from the job's output file, as bg_output reads it, for as long as it hosts the
// session's job service: a running job, or one that ended while its session is still here. Once the
// session has ended here (or the runner restarted without it), the answer is NOT_FOUND and the client
// shows the end of the output the job's wake carried instead.

// bgOutputTailCapabilityV1 declares that this runner answers BackgroundJobTailRequest: @orbit/shared's
// BG_OUTPUT_TAIL_V1. The control plane refuses the read for a runner that does not declare it, and the
// gateway sends the request only to a connection whose Hello did.
const bgOutputTailCapabilityV1 = "bg-output-tail/v1"

const (
	// bgOwnerTailMaxLines and bgOwnerTailMaxBytes bound one answer whatever the request asks for: the
	// card's opened view shows the last 40 lines, and 8 KB of text is plenty for them.
	bgOwnerTailMaxLines = 40
	bgOwnerTailMaxBytes = 8 * 1024
	// bgOwnerTailReadBytes is how much of the file's end is read to find those lines: lines longer than
	// this on average leave fewer than asked for, and the byte cap would cut them anyway.
	bgOwnerTailReadBytes = 64 * 1024
)

// bgJobTailForOwner answers one BackgroundJobTailRequest. It reads a file, so it runs off the link's
// reading goroutine.
func bgJobTailForOwner(req *linkpb.BackgroundJobTailRequest) *linkpb.BackgroundJobTailResponse {
	resp := &linkpb.BackgroundJobTailResponse{
		RequestId: req.GetRequestId(), SessionId: req.GetSessionId(), JobId: req.GetJobId(),
		Outcome: linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_NOT_FOUND,
	}
	svc, ok := bgSessionServices.Load(decodeSessionID(req.GetSessionId()))
	if !ok {
		return resp
	}
	status, ok := svc.(*bgJobService).bg.jobStatus(req.GetJobId())
	if !ok {
		return resp
	}
	resp.Outcome = linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_OK
	resp.Status = status.Status
	if status.ExitCode != nil {
		resp.Exited, resp.ExitCode = true, int32(*status.ExitCode)
	}
	raw, size, older := readOutputEnd(status.OutputPath, bgOwnerTailReadBytes)
	resp.OutputBytes = uint64(size)
	resp.Text, resp.Truncated = ownerTailText(raw, older,
		clampTail(int(req.GetMaxLines()), bgOwnerTailMaxLines), clampTail(int(req.GetMaxBytes()), bgOwnerTailMaxBytes))
	return resp
}

// clampTail is n within [1, limit], with 0 (not asked) read as the limit.
func clampTail(n, limit int) int {
	if n <= 0 || n > limit {
		return limit
	}
	return n
}

// readOutputEnd reads at most limit bytes from the end of a job's output file: the bytes, the file's size,
// and whether anything before them was left out. A file not written yet reads as empty.
func readOutputEnd(path string, limit int64) (string, int64, bool) {
	f, err := openRegularFile(path)
	if err != nil {
		return "", 0, false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", 0, false
	}
	start := max(info.Size()-limit, 0)
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return "", info.Size(), false
	}
	data, err := io.ReadAll(io.LimitReader(f, limit))
	if err != nil {
		return "", info.Size(), false
	}
	return string(data), info.Size(), start > 0
}

// ownerTailText is the last maxLines lines of raw, at most maxBytes long, cleaned as the wake's excerpt
// is (wakeExcerpt): no terminal colour codes, no NUL bytes, valid UTF-8. older says raw starts partway
// through the output, so its first line is a piece and is dropped. The bool says lines were left out.
func ownerTailText(raw string, older bool, maxLines, maxBytes int) (string, bool) {
	text := strings.ReplaceAll(stripANSI(raw), "\x00", "")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	truncated := older
	if older {
		if newline := strings.IndexByte(text, '\n'); newline >= 0 && newline < len(text)-1 {
			text = text[newline+1:]
		}
	}
	// Count lines from the end; a final newline ends the last line rather than starting another.
	body := strings.TrimSuffix(text, "\n")
	if lines := strings.Split(body, "\n"); len(lines) > maxLines {
		text = strings.Join(lines[len(lines)-maxLines:], "\n") + text[len(body):]
		truncated = true
	}
	if len(text) > maxBytes {
		text = text[len(text)-maxBytes:]
		if newline := strings.IndexByte(text, '\n'); newline >= 0 && newline < len(text)-1 {
			text = text[newline+1:]
		}
		truncated = true
	}
	return strings.ToValidUTF8(text, ""), truncated
}
