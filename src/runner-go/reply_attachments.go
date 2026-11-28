package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// How long one upload of one reply file may take, and how many times a file is tried. Each file has
// its own window: a slow server used to spend a shared 20s budget on the first picture and leave
// every later file in the reply as a path no client can open. A second try is for a timeout or a
// dropped connection only; a server that answers no has answered.
var replyAttachmentUploadTimeout = 60 * time.Second

const replyAttachmentUploadAttempts = 2

// What an agent writes when it means "here is the thing I drew": a markdown link to the file it
// just wrote — `![卡在聊天区怎么出现](/root/.orbit/worktrees/<session>/docs/mocks/x.png)`. Those
// bytes are on this machine, behind a bearer-guarded API, so no client can fetch that path: web
// draws it as `.md-image-unavailable`, the native clients as a paperclip chip, and a tap on either
// can only do nothing. The reply has to carry an attachment instead.
//
// The codex engine has always done this at emit time (processAssistant → rewriteLocalMarkdownImages
// in codex_appserver.go). No other engine did, so the same mock rendered as a picture in a codex
// session and as a dead chip in a claude one — which is where nearly every session runs, a BYOK
// provider included (`runtime: claude` is still the claude engine).
//
// This runs at the flush rather than in the reader that parses the engine's stdout: uploading opens
// a file and posts it, and that reader goroutine is also what drains the engine's stdout, so
// stalling it stalls the engine's own writes (see the note on emitThrough). The flusher is already
// this session's ordered async poster, so a batch is rewritten in order, off the engine's back, and
// the run_event row the control plane stores carries the attachment ref.
//
// `roots` is what keeps this to files the reply owns: only a file really inside the session's own
// checkout or its uploads dir is eligible, links resolved, and it is sent as it was opened
// (localFileScope). A path that fails that, and an upload that fails, leave the text exactly as
// written — a chip the user can ask about beats a silently dropped line. A path refused only for
// being outside those directories also gets one line at the end of the reply that says so
// (outsideReplyFilesNote), and a link to a local file that is not there gets one too (missingReplyFilesNote); a failed
// upload of a file inside them does not, as before.
func attachLocalReplyFiles(ctx context.Context, t *Transport, sessionID string, events []RunEvent, roots []string, memo *replyAttachmentIDs) {
	if t == nil || memo == nil || len(events) == 0 {
		return
	}
	upload := memo.uploader(t, sessionID)
	resolveDrive := func(ctx context.Context, p string) (string, error) {
		entry, err := driveStat(ctx, t, p)
		return entry.ID, err
	}
	for i := range events {
		if events[i].Type != evAssistant {
			continue
		}
		text, _ := events[i].Payload["text"].(string)
		// `](` is in every markdown link; skipping the rest avoids running the regex over prose that
		// cannot hold one. Deltas (`evTextDelta`) are left alone: they are a live-typing animation
		// and carry partial text, so a link in one is not there to be resolved yet.
		if !strings.Contains(text, "](") {
			continue
		}
		rewritten, outside, missing := rewriteLocalMarkdownLinks(ctx, text, roots, upload, resolveDrive)
		memo.remember(roots, outside, missing)
		// A failed flush restores the batch it already rewrote, so a retry sees the note it added.
		if note := outsideReplyFilesNote(outside) + missingReplyFilesNote(missing); note != "" && !strings.HasSuffix(rewritten, note) {
			rewritten += note
		}
		events[i].Payload["text"] = rewritten
	}
}

// outsideReplyFilesNote is the line a reply gets when it links files the runner would not attach,
// because they are outside the session's working directory and uploads directory: without it the
// user sees a broken image or a dead chip and nothing says why. "" when there are none.
func outsideReplyFilesNote(paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	names := make([]string, len(paths))
	for i, path := range paths {
		names[i] = "`" + path + "`"
	}
	if len(paths) == 1 {
		return "\n\n_Not attached: " + names[0] + " is outside this session's working directory and uploads directory, so you cannot open it._"
	}
	return "\n\n_Not attached: " + strings.Join(names, ", ") + " are outside this session's working directory and uploads directory, so you cannot open them._"
}

// missingReplyFilesNote is the line a reply gets when it links local files that do not exist where the runner looked:
// the link would render as a dead image or chip, and the agent that wrote it would never learn the file is not there.
// "" when there are none.
func missingReplyFilesNote(paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	names := make([]string, len(paths))
	for i, path := range paths {
		names[i] = "`" + path + "`"
	}
	if len(paths) == 1 {
		return "\n\n_Not attached: " + names[0] + " does not exist in this session's working directory or uploads directory._"
	}
	return "\n\n_Not attached: " + strings.Join(names, ", ") + " do not exist in this session's working directory or uploads directory._"
}

// replyAttachmentIDs remembers what a path uploaded to, for the life of one session run. A flush
// that fails is retried with its batch restored (flushWithContext), and an agent may link the same
// mock in two replies; without this, each attempt uploads another copy of the file and mints
// another id for the same bytes. A path is remembered with the size and modification time of the
// file it was: an agent that redraws a mock in place and links it again in a later turn of the same
// warm run has written new bytes, and must not get the first drawing's id back.
type replyAttachmentIDs struct {
	mu  sync.Mutex
	ids map[string]string
	// What replies linked that could not be attached since the agent's last turn, and the directories that work.
	roots, outside, missing []string
}

// remember keeps the links a reply made that could not be attached, for replyFileCorrection.
func (a *replyAttachmentIDs) remember(roots, outside, missing []string) {
	if len(outside) == 0 && len(missing) == 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.roots = roots
	a.outside = appendMissingStrings(a.outside, outside)
	a.missing = appendMissingStrings(a.missing, missing)
}

func appendMissingStrings(have, add []string) []string {
	for _, s := range add {
		found := false
		for _, h := range have {
			found = found || h == s
		}
		if !found {
			have = append(have, s)
		}
	}
	return have
}

// takeCorrection is the note for the agent's next turn (replyFileCorrection), once: "" when its replies since the
// last turn linked nothing that could not be attached.
func (a *replyAttachmentIDs) takeCorrection() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	note := replyFileCorrection(a.roots, a.outside, a.missing)
	a.outside, a.missing = nil, nil
	return note
}

// replyFileCorrection is what the agent is told at the start of its next turn when a reply linked a file the runner
// could not attach (design D5): the reply-files paragraph is one sentence, and this says the rest where it applies,
// naming the path and the directories that work. "" when there is nothing to correct.
func replyFileCorrection(roots, outside, missing []string) string {
	if len(outside) == 0 && len(missing) == 0 {
		return ""
	}
	quote := func(paths []string) string {
		names := make([]string, len(paths))
		for i, p := range paths {
			names[i] = "`" + p + "`"
		}
		return strings.Join(names, ", ")
	}
	var parts []string
	if len(outside) > 0 {
		parts = append(parts, quote(outside)+" is outside the directories a reply can link from")
	}
	if len(missing) > 0 {
		parts = append(parts, quote(missing)+" does not exist")
	}
	return "[Orbit: your last reply linked a file the user cannot open: " + strings.Join(parts, "; ") + ". Only a file inside " +
		quote(roots) + " is attached: copy it into one of them and link the copy.]"
}

// withReplyFileCorrection is text as the engine is to read it: led by the correction, when there is one.
func withReplyFileCorrection(text, note string) string {
	switch {
	case note == "":
		return text
	case text == "":
		return note
	}
	return note + "\n\n" + text
}

// replyFileMemos is each running session's replyAttachmentIDs: the flush that attaches a reply's files and the loop
// that feeds the agent its next message are different functions of one session, and share this.
var replyFileMemos sync.Map

func replyFilesOf(sessionID string) *replyAttachmentIDs {
	memo, _ := replyFileMemos.LoadOrStore(sessionID, newReplyAttachmentIDs())
	return memo.(*replyAttachmentIDs)
}

func newReplyAttachmentIDs() *replyAttachmentIDs {
	return &replyAttachmentIDs{ids: map[string]string{}}
}

func (a *replyAttachmentIDs) uploader(t *Transport, sessionID string) artifactUploader {
	return func(ctx context.Context, file *os.File, path, mimeType string) (string, error) {
		key := replyFileVersion(file, path)
		a.mu.Lock()
		id, cached := a.ids[key]
		a.mu.Unlock()
		if cached {
			return id, nil
		}
		var err error
		for attempt := 1; ; attempt++ {
			id, err = t.uploadSessionAttachmentFileWithin(ctx, replyAttachmentUploadTimeout, sessionID, file, mimeType, filepath.Base(path))
			var netErr net.Error
			if err == nil || attempt == replyAttachmentUploadAttempts || ctx.Err() != nil || !errors.As(err, &netErr) {
				break
			}
			logln("assistant attachment upload of", path, "failed, trying again:", err)
			if _, err = file.Seek(0, io.SeekStart); err != nil {
				break
			}
		}
		if err != nil {
			return "", err
		}
		a.mu.Lock()
		a.ids[key] = id
		a.mu.Unlock()
		return id, nil
	}
}

// replyFileVersion names the bytes an opened reply file holds: its path, with the size and
// modification time of the file that is open. Without a stat, the path alone.
func replyFileVersion(file *os.File, path string) string {
	info, err := file.Stat()
	if err != nil {
		return path
	}
	return fmt.Sprintf("%s\x00%d\x00%d", path, info.Size(), info.ModTime().UnixNano())
}
