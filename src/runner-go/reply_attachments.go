package main

import (
	"context"
	"strings"
	"sync"
	"time"
)

// How long one flush may spend uploading the files its batch references. Generous next to a
// same-connection upload of a screenshot-sized PNG, and small next to the flush permit it holds.
const replyAttachmentBudget = 20 * time.Second

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
// `roots` is what keeps this to files the reply owns: only a path inside the session's own checkout
// or its uploads dir is eligible, and only if the file is really there (pathWithinRoots stats it).
// A path that fails either test, and an upload that fails, leave the text exactly as written — a
// chip the user can ask about beats a silently dropped line.
func attachLocalReplyFiles(ctx context.Context, t *Transport, sessionID string, events []RunEvent, roots []string, memo *replyAttachmentIDs) {
	if t == nil || memo == nil || len(events) == 0 || len(roots) == 0 {
		return
	}
	upload := memo.uploader(t, sessionID)
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
		events[i].Payload["text"] = rewriteLocalMarkdownImagesWithUploader(ctx, text, roots, upload)
	}
}

// replyAttachmentIDs remembers what a path uploaded to, for the life of one session run. A flush
// that fails is retried with its batch restored (flushWithContext), and an agent may link the same
// mock in two replies; without this, each attempt uploads another copy of the file and mints
// another id for the same bytes.
type replyAttachmentIDs struct {
	mu  sync.Mutex
	ids map[string]string
}

func newReplyAttachmentIDs() *replyAttachmentIDs {
	return &replyAttachmentIDs{ids: map[string]string{}}
}

func (a *replyAttachmentIDs) uploader(t *Transport, sessionID string) artifactUploader {
	return func(ctx context.Context, path, mimeType string) (string, error) {
		a.mu.Lock()
		id, cached := a.ids[path]
		a.mu.Unlock()
		if cached {
			return id, nil
		}
		id, err := t.uploadSessionAttachment(ctx, sessionID, path, mimeType)
		if err != nil {
			return "", err
		}
		a.mu.Lock()
		a.ids[path] = id
		a.mu.Unlock()
		return id, nil
	}
}
