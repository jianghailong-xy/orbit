package main

import (
	"strings"
	"testing"
	"time"

	"orbit/link-gateway/linkpb"
)

// StreamPaste and StreamPasted (docs/runner-browser-design.md §5): the owner's paste rides the open stream to a runner
// that declares link-stream-paste-v1, outside the stream's window, and the runner's answer comes back on .up.

const pasteText = "密码 Pässwörd 🔑"

func pasteHello(process string) *linkpb.Frame {
	f := streamHello(process)
	f.GetHello().Capabilities = append(f.GetHello().Capabilities, streamPasteCapability)
	return f
}

func pasteFrame(id string, pasteID uint32, text string) *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_StreamPaste{StreamPaste: &linkpb.StreamPaste{StreamId: id, PasteId: pasteID, Text: text}}}
}

func TestAPasteReachesTheRunnerExactlyAndItsAnswerComesBack(t *testing.T) {
	r := newStreamRig(t, pasteHello)
	r.open(streamA)
	r.down(streamA, pasteFrame(streamA, 7, pasteText))
	got := r.tc.await("stream_paste", 5*time.Second, nil).GetStreamPaste()
	if got.GetStreamId() != streamA || got.GetPasteId() != 7 || got.GetText() != pasteText {
		t.Fatalf("StreamPaste %v", got)
	}
	r.send(&linkpb.Frame{Body: &linkpb.Frame_StreamPasted{StreamPasted: &linkpb.StreamPasted{StreamId: streamA, PasteId: 7}}})
	eventually(t, 5*time.Second, "the answer is published", func() bool { return len(r.up(streamA)) == 1 })
	if a := r.up(streamA)[0].GetStreamPasted(); a.GetPasteId() != 7 || a.GetError() != "" || a.GetStreamId() != streamA {
		t.Fatalf("published %v", a)
	}
	// A paste takes no room in the stream's window: the viewer may still send a whole window of bytes.
	r.down(streamA, dataFrame(streamA, make([]byte, streamWindow)))
	n := 0
	for n < streamWindow {
		n += len(r.tc.await("stream_data", 5*time.Second, nil).GetStreamData().GetData())
	}
}

func TestAPasteToARunnerThatDoesNotTakeOneIsAnsweredByTheGateway(t *testing.T) {
	r := newStreamRig(t, streamHello)
	r.open(streamA)
	r.down(streamA, pasteFrame(streamA, 1, pasteText))
	eventually(t, 5*time.Second, "the answer is published", func() bool { return len(r.up(streamA)) == 1 })
	if a := r.up(streamA)[0].GetStreamPasted(); a.GetPasteId() != 1 || !strings.Contains(a.GetError(), "cannot take a paste") {
		t.Fatalf("published %v", a)
	}
	r.tc.quiet(200 * time.Millisecond)
}

func TestAPasteOverTheCapClosesTheStream(t *testing.T) {
	r := newStreamRig(t, pasteHello)
	r.open(streamA)
	r.down(streamA, pasteFrame(streamA, 1, strings.Repeat("x", maxPasteBytes+1)))
	if c := r.tc.await("stream_close", 5*time.Second, nil).GetStreamClose(); c.GetCode() != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_FLOW_VIOLATION {
		t.Fatalf("StreamClose %v", c)
	}
}

func TestAPasteSummaryNamesItsLengthNotItsText(t *testing.T) {
	line := summarize(pasteFrame(streamA, 3, pasteText))
	if strings.Contains(line, "Pässwörd") || !strings.Contains(line, "text=") {
		t.Fatalf("summary %q", line)
	}
}
