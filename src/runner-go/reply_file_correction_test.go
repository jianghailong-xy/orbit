package main

import (
	"strings"
	"testing"
)

// D5: the next turn says so when a reply linked a file that could not be attached.
func TestReplyFileCorrectionFiresForATmpLinkAndNotForAValidOne(t *testing.T) {
	roots := []string{"/work/checkout", "/work/uploads"}
	memo := newReplyAttachmentIDs()

	memo.remember(roots, nil, nil) // a reply whose links were all attached
	if note := memo.takeCorrection(); note != "" {
		t.Fatalf("a valid link got a correction: %s", note)
	}

	memo.remember(roots, []string{"/tmp/shot.png"}, nil)
	memo.remember(roots, []string{"/tmp/shot.png"}, []string{"out/gone.png"}) // a retried flush sees the same link again
	note := memo.takeCorrection()
	for _, want := range []string{"`/tmp/shot.png`", "outside", "`out/gone.png`", "does not exist", "`/work/checkout`", "`/work/uploads`", "copy it into one of them"} {
		if !strings.Contains(note, want) {
			t.Errorf("the correction does not say %q: %s", want, note)
		}
	}
	if strings.Count(note, "/tmp/shot.png") != 1 {
		t.Errorf("a path flushed twice is named twice: %s", note)
	}
	if again := memo.takeCorrection(); again != "" {
		t.Errorf("the correction was given twice: %s", again)
	}
}

func TestReplyFileCorrectionLeadsTheNextMessage(t *testing.T) {
	if got := withReplyFileCorrection("Continue.", ""); got != "Continue." {
		t.Errorf("no correction changed the message: %q", got)
	}
	note := replyFileCorrection([]string{"/w"}, []string{"/tmp/a.png"}, nil)
	if got := withReplyFileCorrection("Continue.", note); got != note+"\n\nContinue." {
		t.Errorf("the correction does not lead the message: %q", got)
	}
	if got := withReplyFileCorrection("", note); got != note {
		t.Errorf("a message that is only the correction: %q", got)
	}
}

func TestOneSentenceStaysForReplyFiles(t *testing.T) {
	if strings.Count(orbitReplyFileInstructions, ".") > 2 || len(orbitReplyFileInstructions) > 200 {
		t.Errorf("the reply-files paragraph grew back: %q", orbitReplyFileInstructions)
	}
}
