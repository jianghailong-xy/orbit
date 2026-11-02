package main

import (
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// artifactUploader sends a file already opened and judged (localFileScope.open). path is what the reply called it, for
// its name; nothing reads it again.
type artifactUploader func(ctx context.Context, file *os.File, path, mimeType string) (string, error)

var markdownAttachmentRE = regexp.MustCompile(`(!?)\[([^\]]*)\]\((<?[^)\s]+>?)(\s+(?:"[^"]*"|'[^']*'))?\)`)

func rewriteLocalMarkdownImages(ctx context.Context, t *Transport, sessionID, text string, roots []string) string {
	return rewriteLocalMarkdownImagesWithUploader(ctx, text, roots, func(ctx context.Context, file *os.File, path, mimeType string) (string, error) {
		return t.uploadSessionAttachmentFile(ctx, sessionID, file, mimeType, filepath.Base(path))
	})
}

// replyFileScope is what a reply may link. The first root, where its relative links start, is the session's working
// directory: named under Orbit's directory it is a session's own like the others, and anywhere else it is the owner's
// project directory, which goes as any other root.
func replyFileScope(roots []string) localFileScope {
	if workDir := roots[0]; !pathInsideAny(workDir, absPath(machineHome()), realPath(machineHome())) {
		return newLocalFileScope(roots[1:], workDir)
	}
	return newLocalFileScope(roots)
}

func rewriteLocalMarkdownImagesWithUploader(ctx context.Context, text string, roots []string, upload artifactUploader) string {
	if text == "" || upload == nil || len(roots) == 0 {
		return text
	}
	cleanRoots := cleanExistingRoots(roots)
	if len(cleanRoots) == 0 {
		return text
	}
	scope := replyFileScope(cleanRoots)
	uploaded := map[string]string{}
	return markdownAttachmentRE.ReplaceAllStringFunc(text, func(match string) string {
		parts := markdownAttachmentRE.FindStringSubmatch(match)
		if len(parts) < 5 {
			return match
		}
		raw := strings.Trim(parts[3], "<>")
		if skipMarkdownAttachmentSrc(raw) {
			return match
		}
		path := localMarkdownImagePath(raw, cleanRoots[0])
		if path == "" {
			return match
		}
		file, _, err := scope.open(path)
		if err != nil {
			return match
		}
		defer file.Close()
		isImage := parts[1] == "!"
		mimeType := attachmentMimeOf(file, path)
		if isImage && !strings.HasPrefix(mimeType, "image/") {
			return match
		}
		id := uploaded[path]
		if id == "" {
			var err error
			id, err = upload(ctx, file, path, mimeType)
			if err != nil {
				logln("assistant attachment upload failed for", path+":", err)
				return match
			}
			uploaded[path] = id
		}
		if isImage {
			return fmt.Sprintf("![%s](orbit-attachment:%s%s)", parts[2], id, parts[4])
		}
		return fmt.Sprintf("[%s](orbit-attachment:%s %q)", parts[2], id, filepath.Base(path))
	})
}

// codexGeneratedImagesDir is the directory Codex's image tools write into —
// CODEX_HOME/generated_images, outside both the worktree and the session's uploads dir. A reply
// linking one of those files would otherwise carry a path only the runner can read (every client
// renders it as an unreachable file), so it counts as an upload root. Empty when the home can't be
// resolved; cleanExistingRoots drops that, and any root that doesn't exist yet.
func codexGeneratedImagesDir(env []string, cwd string) string {
	home, err := effectiveCodexHome(env, cwd)
	if err != nil {
		return ""
	}
	return filepath.Join(home, "generated_images")
}

// stageCodexGeneratedImage keeps a generated image in the session's own uploads directory when
// the control-plane attachment upload is temporarily unavailable. The uploads directory is both
// outside the worktree (so it cannot enter a commit) and an allowed legacy-artifact root (so the
// clients can fetch the bytes while the normal flush or artifact-request path retries the
// attachment upload.
func stageCodexGeneratedImage(path, generatedRoot, uploadRoot string) string {
	if path == "" || generatedRoot == "" || uploadRoot == "" {
		return ""
	}
	file, _, err := newLocalFileScope([]string{generatedRoot}).open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	if !strings.HasPrefix(attachmentMimeOf(file, path), "image/") {
		return ""
	}
	destination, err := saveLocalFile(filepath.Dir(uploadRoot), []string{filepath.Base(uploadRoot)}, filepath.Base(path), func(w io.Writer) error {
		_, err := io.Copy(w, file)
		return err
	})
	if err != nil {
		return ""
	}
	return destination
}

func skipMarkdownAttachmentSrc(src string) bool {
	lower := strings.ToLower(strings.TrimSpace(src))
	return lower == "" ||
		strings.HasPrefix(lower, "data:") ||
		strings.HasPrefix(lower, "http://") ||
		strings.HasPrefix(lower, "https://") ||
		strings.HasPrefix(lower, "orbit-attachment:")
}

func localMarkdownImagePath(src, baseDir string) string {
	if strings.ContainsAny(src, "?#") {
		return ""
	}
	unescaped, err := url.PathUnescape(src)
	if err != nil {
		unescaped = src
	}
	if filepath.IsAbs(unescaped) {
		return filepath.Clean(unescaped)
	}
	return filepath.Clean(filepath.Join(baseDir, unescaped))
}

func cleanExistingRoots(roots []string) []string {
	out := make([]string, 0, len(roots))
	seen := map[string]bool{}
	for _, root := range roots {
		if root == "" {
			continue
		}
		clean, err := filepath.Abs(root)
		if err != nil {
			clean = filepath.Clean(root)
		}
		if seen[clean] {
			continue
		}
		if st, err := os.Stat(clean); err == nil && st.IsDir() {
			out = append(out, clean)
			seen[clean] = true
		}
	}
	return out
}

// attachmentMimeOf says what an opened file is: by its name, or by sniffing the handle, which moves no offset. A sniff
// never opens by path, which may mean something else by now.
func attachmentMimeOf(file *os.File, name string) string {
	if typ := mime.TypeByExtension(strings.ToLower(filepath.Ext(name))); typ != "" {
		return typ
	}
	buf := make([]byte, 512)
	n, _ := file.ReadAt(buf, 0)
	if n == 0 {
		return "application/octet-stream"
	}
	return http.DetectContentType(buf[:n])
}
