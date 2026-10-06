package main

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

var errWorktreePreviewUnsupported = errors.New("Worktree file previews require Go 1.24 or newer")

// Worktree requests name the current file relative to an existing checkout. They
// never restore a collected checkout or fall back to the session's uploads dir.
func uploadWorktreeArtifact(ctx context.Context, t *Transport, req ArtifactCommand) ArtifactResultRequest {
	out := ArtifactResultRequest{RequestID: req.RequestID, Status: "error"}
	if !uuidRE.MatchString(decodeSessionID(req.SessionID)) || !validWorktreeArtifactPath(req.Path) {
		out.Message = "Invalid worktree file path"
		return out
	}
	for _, root := range artifactRequestRoots(req.SessionID)[1:] {
		// A checkout itself must be a directory, not an alias to another session.
		rootInfo, err := os.Lstat(root)
		if err != nil || !rootInfo.IsDir() {
			continue
		}
		realRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		path, err := filepath.EvalSymlinks(filepath.Join(realRoot, req.Path))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			out.Message = "File could not be read"
			return out
		}
		rel, err := filepath.Rel(realRoot, path)
		if err != nil || !validWorktreeArtifactPath(rel) {
			out.Message = "File is outside the session worktree"
			return out
		}
		info, err := os.Stat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			out.Message = "File is empty or is not a regular file"
			return out
		}
		if info.Size() > maxSessionAttachmentBytes {
			out.ErrorCode = "too_large"
			out.Message = errAttachmentTooLarge.Error()
			return out
		}
		file, err := openWorktreeArtifactFile(root, rel, rootInfo)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			out.Message = "File could not be read safely"
			if errors.Is(err, errWorktreePreviewUnsupported) {
				out.Message = "Update the runner to preview worktree files"
			}
			return out
		}
		defer file.Close()
		// Sniff only the validated open handle, so changing the path cannot redirect
		// either MIME detection or the uploaded bytes outside the checkout.
		mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(req.Path)))
		if mimeType == "" {
			buf := make([]byte, 512)
			n, _ := file.ReadAt(buf, 0)
			mimeType = http.DetectContentType(buf[:n])
		}
		id, err := t.uploadSessionAttachmentFile(ctx, req.SessionID, file, mimeType, filepath.Base(req.Path))
		if err != nil {
			if errors.Is(err, errAttachmentTooLarge) {
				out.ErrorCode = "too_large"
				out.Message = errAttachmentTooLarge.Error()
			} else if os.IsNotExist(err) {
				out.Status = "missing"
				out.Message = "File is no longer available in this session's worktree"
			} else {
				out.Message = "File could not be uploaded"
			}
			return out
		}
		out.Status = "uploaded"
		out.AttachmentID = id
		return out
	}
	out.Status = "missing"
	out.Message = "File is no longer available in this session's worktree"
	return out
}

func validWorktreeArtifactPath(path string) bool {
	if !filepath.IsLocal(path) || strings.Contains(path, "\\") {
		return false
	}
	if len(path) > 1 && path[1] == ':' && ((path[0] >= 'a' && path[0] <= 'z') || (path[0] >= 'A' && path[0] <= 'Z')) {
		return false
	}
	for _, char := range path {
		if char < 32 || char == 127 {
			return false
		}
	}
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		if part == "" || part == "." || part == ".." || strings.EqualFold(part, ".git") {
			return false
		}
	}
	return true
}
