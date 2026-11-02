package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// The file tools (docs/orbit-files-design.md §2.2, §2.3): how an agent keeps a screenshot or a report in Orbit instead
// of committing it, and gets it back. `file_upload`, `file_fetch` and `file_list` are `orbit file upload|fetch|list`
// (file_cli.go), which run the runFileTool below: one implementation, two doors.
//
// They are control-plane calls this process makes itself, with the runner credential, over HTTPS (the upload is
// multipart and the download raw bytes, like the attachments'). Upload and fetch act for the session they are called
// from: a file stays with the session that uploads it, and arrives in that session's uploads directory, which is
// outside the checkout, so neither direction can put a file in a commit. What may be uploaded is the session's own
// checkout and uploads directory and nothing else (fileUploadScope).

// The limits a request would be refused against (apiserver files/files.service.ts), stated so that a folder that cannot
// be kept is refused before anything of it is sent. maxSessionAttachmentBytes is the third.
const (
	fileBundleMaxFiles     = 1000
	fileBundleMaxPathChars = 1024
	fileLabelMaxChars      = 200
)

// fileCallTimeout is how long one file may take to travel. Longer than the attachments' 35 seconds, which were chosen
// for a screenshot: this one may be 25 MiB on a home connection.
const fileCallTimeout = 2 * time.Minute

// fileDoorRoute is the upload route. Not the attachment route, which an older server would answer 200 while ignoring
// every field this sends: this path, it answers 404, which fileCallError turns into a sentence.
func fileDoorRoute(sessionID string) string { return "/runner/sessions/" + sessionID + "/files" }

// sessionFile is one file as the server describes it. On the machine door `id` is the UUID and `publicId` the short id;
// on every other door both are the short id. An agent is shown the short id, so that the same file is spelled the same
// by every tool.
type sessionFile struct {
	ID        string `json:"id"`
	PublicID  string `json:"publicId"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Label     string `json:"label"`
	MimeType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
	CreatedAt string `json:"createdAt"`
}

func (f sessionFile) id() string {
	if f.PublicID != "" {
		return f.PublicID
	}
	return f.ID
}

// fileLink is what a reply writes to show a file: every client renders it.
func fileLink(id string) string { return "orbit-attachment:" + id }

// fileAnswer is one file as a tool reports it.
type fileAnswer struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Name      string `json:"name,omitempty"`
	Label     string `json:"label,omitempty"`
	MimeType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
	// Empty only on a row from before Orbit Files, whose bytes the server has not hashed yet.
	SHA256    string `json:"sha256,omitempty"`
	Link      string `json:"link"`
	CreatedAt string `json:"createdAt,omitempty"`
	// Where file_fetch put it.
	Path string `json:"path,omitempty"`
	// A bundle's files, by path: from file_upload, or from file_fetch out of its manifest.
	Files []fileBundleFile `json:"files,omitempty"`
	// What file_upload found in the folder and did not keep, so that nothing is left out without saying so.
	Skipped []skippedFile `json:"skipped,omitempty"`
}

func answerFor(f sessionFile) fileAnswer {
	return fileAnswer{
		ID: f.id(), Kind: f.Kind, Name: f.Name, Label: f.Label, MimeType: f.MimeType,
		SizeBytes: f.SizeBytes, SHA256: f.SHA256, Link: fileLink(f.id()), CreatedAt: f.CreatedAt,
	}
}

// fileBundleFile is one file of a bundle. `link` is this binary's: the manifest it is read from has no use for one.
type fileBundleFile struct {
	Path      string `json:"path"`
	ID        string `json:"id"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes"`
	MimeType  string `json:"mimeType,omitempty"`
	Link      string `json:"link"`
}

// fileBundleManifest is what a bundle's bytes are (apiserver FileBundleManifest).
type fileBundleManifest struct {
	Kind  string           `json:"kind"`
	Files []fileBundleFile `json:"files"`
}

// skippedFile is an entry of a folder that was not uploaded, and why.
type skippedFile struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// ── The calls ───────────────────────────────────────────────────────────────────────────────────

// uploadFile keeps one file. The name goes out through mime.FormatMediaType, which writes RFC 5987 `filename*` for a
// name a quoted string cannot carry: busboy reads a plain filename as Latin-1.
func (t *Transport) uploadFile(parent context.Context, sessionID, path, name, mimeType string, fields map[string]string) (sessionFile, error) {
	var out sessionFile
	file, err := os.Open(path)
	if err != nil {
		return out, err
	}
	defer file.Close()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			return out, err
		}
	}
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": "file", "filename": name}))
	header.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return out, err
	}
	// The file may grow after it was measured; read at most one byte beyond the limit.
	n, err := io.Copy(part, io.LimitReader(file, maxSessionAttachmentBytes+1))
	if err != nil {
		return out, err
	}
	if n > maxSessionAttachmentBytes {
		return out, errAttachmentTooLarge
	}
	if err := writer.Close(); err != nil {
		return out, err
	}
	ctx, cancel := context.WithTimeout(parent, fileCallTimeout)
	defer cancel()
	route := fileDoorRoute(sessionID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.baseURL+"/api"+route, &body)
	if err != nil {
		return out, err
	}
	req.Header.Set("content-type", writer.FormDataContentType())
	t.authorizeFileCall(req)
	resp, err := t.client.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return out, fmt.Errorf("POST %s: reading response body: %w", route, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return out, &transportHTTPError{method: http.MethodPost, path: route, statusCode: resp.StatusCode, body: string(data)}
	}
	return out, json.Unmarshal(data, &out)
}

// authorizeFileCall is what every call this process makes by hand carries, as the attachment calls do.
func (t *Transport) authorizeFileCall(req *http.Request) {
	if t.token != "" {
		req.Header.Set("authorization", "Bearer "+t.token)
		setManagedInstanceHeaders(req.Header)
		t.setCaller(req.Header)
	}
}

// bundleEntry names one uploaded file of a folder, by the path it had there.
type bundleEntry struct {
	Path string `json:"path"`
	ID   string `json:"id"`
}

func (t *Transport) createFileBundle(sessionID, name, label string, files []bundleEntry) (sessionFile, error) {
	body := map[string]interface{}{"name": name, "files": files}
	if label != "" {
		body["label"] = label
	}
	var out sessionFile
	err := t.do(nil, http.MethodPost, "/runner/sessions/"+sessionID+"/file-bundles", body, &out, fileCallTimeout)
	return out, err
}

func (t *Transport) describeFile(sessionID, fileID string) (sessionFile, error) {
	var out sessionFile
	err := t.do(nil, http.MethodGet, "/runner/sessions/"+sessionID+"/files/"+url.PathEscape(fileID), nil, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) listFiles(filter url.Values) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.do(nil, http.MethodGet, "/runner/files?"+filter.Encode(), nil, &out, taskOpTimeout)
	return out, err
}

// downloadFile streams one file's bytes into dest and answers their sha256 and length. It writes beside dest and
// renames into place only once they are all there and match `want`, so that a dropped connection or a wrong byte
// leaves no file that looks fetched. `want` is empty for a row from before Orbit Files, which has no sha256 to match.
func (t *Transport) downloadFile(parent context.Context, sessionID, fileID, dest, want string) (string, int64, error) {
	ctx, cancel := context.WithTimeout(parent, fileCallTimeout)
	defer cancel()
	route := "/runner/sessions/" + sessionID + "/attachments/" + url.PathEscape(fileID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.baseURL+"/api"+route, nil)
	if err != nil {
		return "", 0, err
	}
	t.authorizeFileCall(req)
	resp, err := t.client.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return "", 0, &transportHTTPError{method: http.MethodGet, path: route, statusCode: resp.StatusCode, body: string(data)}
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", 0, err
	}
	temp, err := os.CreateTemp(filepath.Dir(dest), ".fetch-*")
	if err != nil {
		return "", 0, err
	}
	defer os.Remove(temp.Name())
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(temp, hash), resp.Body)
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", 0, err
	}
	got := hex.EncodeToString(hash.Sum(nil))
	if want != "" && got != want {
		return "", 0, fmt.Errorf("the bytes received hash to %s, not the %s Orbit holds; nothing was saved", got, want)
	}
	if err := os.Chmod(temp.Name(), 0o644); err != nil {
		return "", 0, err
	}
	return got, n, os.Rename(temp.Name(), dest)
}

// ── The tools ───────────────────────────────────────────────────────────────────────────────────

// fileToolNames is the set callFileTool answers for.
var fileToolNames = map[string]bool{"file_upload": true, "file_fetch": true, "file_list": true}

// fileToolContext is who a file tool acts for, the session it is called from when there is one, and how long it has.
type fileToolContext struct {
	sessionID string
	// callTimeout is the engine's own deadline on this call, and 0 when it waits for as long as the call takes
	// (envMCPCallTimeout). Past it the engine reports the call failed while this process carries on, and the agent's
	// retry queues behind it and keeps everything a second time, so a call stops at the longest it may hold the engine
	// and says what it got done.
	callTimeout time.Duration
}

// callContext is the time this call has.
func (c fileToolContext) callContext() (context.Context, context.CancelFunc) {
	if wait := longestInlineWait(c.callTimeout); wait > 0 {
		return context.WithTimeout(context.Background(), wait)
	}
	return context.WithCancel(context.Background())
}

// callFileTool runs one file tool for the session this server runs in, and reports whether it handled the name.
func (s *mcpServer) callFileTool(name string, args map[string]interface{}) (map[string]interface{}, bool) {
	if !fileToolNames[name] {
		return nil, false
	}
	raw, err := runFileTool(s.t, fileToolContext{sessionID: strings.TrimSpace(s.sessionID), callTimeout: s.callTimeout}, name, args)
	if err != nil {
		return toolResult(err.Error(), true), true
	}
	return toolResult(prettyJSON(raw), false), true
}

// runFileTool is one call of a file tool, from either door.
func runFileTool(t *Transport, tool fileToolContext, name string, args map[string]interface{}) (json.RawMessage, error) {
	var answer interface{}
	var err error
	switch name {
	case "file_upload":
		answer, err = uploadPath(t, tool, getString(args, "path"), getString(args, "taskId"), getString(args, "label"))
	case "file_fetch":
		answer, err = fetchFile(t, tool, getString(args, "id"))
	case "file_list":
		return listSessionFiles(t, tool, getString(args, "taskId"), getString(args, "sessionId"), getString(args, "evidenceId"))
	default:
		return nil, fmt.Errorf("unknown file tool %q", name)
	}
	if err != nil {
		return nil, err
	}
	return json.Marshal(answer)
}

// fileTimeoutError says a call stopped at the engine's deadline.
func fileTimeoutError(action string, timeout time.Duration) error {
	return fmt.Errorf("%s: this engine ends a tool call after %s, so this one stopped first and nothing was kept. "+
		"Run `orbit file` in a shell, which has no such limit", action, timeout)
}

// folderTimeoutError says how far a folder got by the engine's deadline, and which of its files were not uploaded, in
// the order they were sent. The one in flight is among them: it may have been kept, and nothing says so.
func folderTimeoutError(root string, files []folderFile, kept int, timeout time.Duration) error {
	const shown = 20
	left := files[kept:]
	names := make([]string, 0, shown)
	for _, file := range left[:min(len(left), shown)] {
		names = append(names, file.rel)
	}
	more := ""
	if len(left) > shown {
		more = fmt.Sprintf(" and %d more in path order", len(left)-shown)
	}
	return fmt.Errorf("file_upload %s: this engine ends a tool call after %s, so this one stopped first: %d of %d files were "+
		"kept, no bundle was made, and these were not uploaded: %s%s. Uploading the folder again sends every file again and "+
		"stores no byte twice. Upload its subdirectories one at a time, or run `orbit file upload` in a shell, which has no "+
		"such limit", root, timeout, kept, len(files), strings.Join(names, ", "), more)
}

// fileSessionOf is the session a tool that needs one acts for, as a path segment.
func fileSessionOf(tool fileToolContext, name string) (string, error) {
	if tool.sessionID == "" {
		return "", fmt.Errorf("%s acts for the Orbit session it is called from (ORBIT_SESSION_ID), and there is none here: a "+
			"file stays with the session that uploads it, and arrives in that session's uploads directory", name)
	}
	if err := validatePathSegmentID(tool.sessionID); err != nil {
		return "", fmt.Errorf("ORBIT_SESSION_ID %w", err)
	}
	return tool.sessionID, nil
}

// fileCallError says what failed. A server without the door says so in words: this binary can be newer than the
// control plane it talks to, and a bare 404 reads like a wrong id. Nest's answer for a route it does not have is the
// only 404 that says "Cannot"; the doors' own say what they did not find.
func fileCallError(action string, err error) error {
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound && strings.Contains(httpErr.body, "Cannot "+httpErr.method+" ") {
		return fmt.Errorf("%s: this Orbit server has no file door for agents yet (it answered 404 for /api%s), so nothing "+
			"was kept or read, and this says nothing about whether the file exists. Upgrade the Orbit server to use the file tools", action, httpErr.path)
	}
	return fmt.Errorf("%s: %w", action, err)
}

// uploadPath is file_upload: a file, or a directory as one bundle.
func uploadPath(t *Transport, tool fileToolContext, path, taskID, label string) (fileAnswer, error) {
	var out fileAnswer
	sessionID, err := fileSessionOf(tool, "file_upload")
	if err != nil {
		return out, err
	}
	if strings.TrimSpace(path) == "" {
		return out, errors.New("file_upload: path is required")
	}
	// Here rather than left to the server, which would say so only after a whole folder had been uploaded.
	if utf8.RuneCountInString(label) > fileLabelMaxChars || strings.ContainsFunc(label, unicode.IsControl) {
		return out, fmt.Errorf("file_upload: a label is at most %d characters, with no control characters", fileLabelMaxChars)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return out, fmt.Errorf("file_upload: %w", err)
	}
	// Where the path really is, which is what the scope and everything after it go by: a link named here is followed
	// and judged by its target, and a link inside a folder is not followed at all.
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return out, fmt.Errorf("file_upload: %w", err)
	}
	scope := newFileUploadScope(sessionID)
	if reason := scope.refuses(real); reason != "" {
		return out, fileScopeError(abs, reason, sessionID)
	}
	info, err := os.Stat(real)
	if err != nil {
		return out, fmt.Errorf("file_upload: %w", err)
	}
	fields := map[string]string{}
	if taskID != "" {
		fields["taskId"] = taskID
	}
	if !info.IsDir() {
		if label != "" {
			fields["label"] = label
		}
		if !info.Mode().IsRegular() || info.Size() == 0 {
			return out, fmt.Errorf("file_upload: %s is empty or is not a regular file", abs)
		}
		if info.Size() > maxSessionAttachmentBytes {
			return out, fmt.Errorf("file_upload: %s: %w", abs, errAttachmentTooLarge)
		}
		ctx, cancel := tool.callContext()
		defer cancel()
		file, err := t.uploadFile(ctx, sessionID, real, filepath.Base(abs), attachmentMime(real), fields)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return out, fileTimeoutError("file_upload "+abs, tool.callTimeout)
		}
		if err != nil {
			return out, fileCallError("file_upload "+abs, err)
		}
		return answerFor(file), nil
	}
	return uploadFolder(t, tool, sessionID, abs, real, scope, label, fields)
}

// fileUploadScope is what file_upload may read: this session's own checkout and uploads directory, the rule a reply's
// links follow (attachLocalReplyFiles). The tool needs it more than a reply does. Orbit's MCP tools are always allowed,
// with no prompt in any permission mode, and this process runs outside the engine's sandbox, so a path it read without
// asking would be a way around both, and file_fetch would hand back what it read.
//
// Orbit's own directory is refused first and whatever the roots say, because it holds the machine's credentials, which
// are kept in a file exactly so that they stay out of the engine (cmdMcp), and because a root can be wider than a
// checkout: a home directory that is itself a git repository is its own checkout, by what git says. Nothing else is
// listed by name. Such a root still reaches the rest of that home, ~/.ssh included: a list of other people's credential
// directories could not be complete, and the session could read them there anyway if it was given that repository.
type fileUploadScope struct {
	// Orbit's own directory (machineHome).
	home string
	// What in it is this session's: its uploads directory and its checkout.
	own []string
	// Where a path may be: those, and the checkout this process runs in.
	roots []string
}

// newFileUploadScope reads the working directory: the checkout a call means is the one it was made from, and no variable
// names it. `cd` moves the CLI's, which runs inside the engine's own shell permissions.
func newFileUploadScope(sessionID string) fileUploadScope {
	own := []string{realPath(uploadsDir(sessionID)), realPath(filepath.Join(worktreesDir(), decodeSessionID(sessionID)))}
	scope := fileUploadScope{home: realPath(machineHome()), own: own, roots: own}
	if cwd, err := os.Getwd(); err == nil {
		checkout, err := git(cwd, "rev-parse", "--show-toplevel")
		if err != nil {
			checkout = cwd
		}
		scope.roots = append(own[:len(own):len(own)], realPath(checkout))
	}
	return scope
}

// refuses says why a path, with its links resolved, may not be read, and "" when it may.
func (s fileUploadScope) refuses(real string) string {
	if pathInsideAny(real, s.home) && !pathInsideAny(real, s.own...) {
		return "inside Orbit's own directory, which holds this machine's credentials"
	}
	if !pathInsideAny(real, s.roots...) {
		return "outside this session's checkout and uploads directory"
	}
	return ""
}

// realPath is path with its links resolved, or as it stands when it does not exist yet.
func realPath(path string) string {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return filepath.Clean(path)
}

// pathInsideAny reports whether path is one of the roots or under one.
func pathInsideAny(path string, roots ...string) bool {
	for _, root := range roots {
		rel, err := filepath.Rel(root, path)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// fileScopeError refuses a path, and names the directory a file can go through: the uploads directory, which is made
// here so that the copy this asks for works. Inside Orbit's own directory it asks for no copy: what is there is not
// the session's to send anywhere.
func fileScopeError(path, reason, sessionID string) error {
	uploads := uploadsDir(sessionID)
	_ = os.MkdirAll(uploads, 0o755)
	next := "Copy the file there first."
	if strings.HasPrefix(reason, "inside") {
		next = "That file is not one to upload."
	}
	return fmt.Errorf("file_upload: %s is %s, so nothing was uploaded. file_upload reads only this session's checkout and "+
		"its uploads directory, %s, the same rule a reply's links follow. %s", path, reason, uploads, next)
}

// uploadFolder keeps a directory as a bundle: every file under it, then the manifest that names them by path. The
// files are measured before the first one is sent, so that a folder that cannot be kept costs nothing. A failure part
// way leaves files no manifest names: they are this session's, nothing is wrong with them, and a retry stores no byte
// twice.
func uploadFolder(t *Transport, tool fileToolContext, sessionID, root, resolved string, scope fileUploadScope, label string, fields map[string]string) (fileAnswer, error) {
	var out fileAnswer
	files, skipped, err := walkFolder(resolved, scope)
	if err != nil {
		return out, fmt.Errorf("file_upload %s: %w", root, err)
	}
	if len(files) == 0 {
		return out, fmt.Errorf("file_upload %s: this folder holds no file that can be kept; skipped: %v", root, skipped)
	}
	ctx, cancel := tool.callContext()
	defer cancel()
	entries := make([]bundleEntry, 0, len(files))
	bundled := map[string]fileBundleFile{}
	for _, file := range files {
		uploaded, err := t.uploadFile(ctx, sessionID, file.path, filepath.Base(file.path), attachmentMime(file.path), fields)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return out, folderTimeoutError(root, files, len(entries), tool.callTimeout)
		}
		if err != nil {
			return out, fileCallError(fmt.Sprintf("file_upload %s: %s (%d of %d files had been kept, and no bundle was made)",
				root, file.rel, len(entries), len(files)), err)
		}
		entries = append(entries, bundleEntry{Path: file.rel, ID: uploaded.id()})
		bundled[file.rel] = fileBundleFile{
			Path: file.rel, ID: uploaded.id(), SHA256: uploaded.SHA256, SizeBytes: uploaded.SizeBytes,
			MimeType: uploaded.MimeType, Link: fileLink(uploaded.id()),
		}
	}
	bundle, err := t.createFileBundle(sessionID, filepath.Base(resolved), label, entries)
	if err != nil {
		return out, fileCallError(fmt.Sprintf("file_upload %s: the bundle of %d files", root, len(files)), err)
	}
	out = answerFor(bundle)
	for _, entry := range entries {
		out.Files = append(out.Files, bundled[entry.Path])
	}
	out.Skipped = skipped
	return out, nil
}

// folderFile is one regular file of a folder: where it is, and its path in the folder, with / between its parts.
type folderFile struct {
	path string
	rel  string
}

// walkFolder is the files of a directory, in lexical order, and what it left out. It does not follow a symbolic link: a
// link in a folder can name anything on this machine, and an agent that uploads a directory did not ask for that.
//
// It stops at the first thing that refuses the whole folder, so that a mistaken node_modules is turned down at once
// rather than after a walk of it: more entries than a bundle holds (fileBundleMaxFiles, counting the skipped, which go
// into the answer too), or one file too large to keep. What cannot be kept for a reason of its own is listed instead of
// refusing the folder around it: an empty file, an entry that cannot be read, and a path the server would refuse, which
// would otherwise be found out once everything else had been uploaded. Each file is opened here rather than only
// measured: a mode 000 file has a size, and only the open tells it apart.
//
// Each entry is held to the scope by itself, as the folder was: a folder a home-rooted repository lets through has
// Orbit's own directory inside it, which is skipped whole. Nothing here follows a link, so a file's real path is the
// walk's, and resolving it again is what keeps that true of a directory swapped for a link since the walk began.
func walkFolder(root string, scope fileUploadScope) ([]folderFile, []skippedFile, error) {
	var files []folderFile
	var skipped []skippedFile
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		skip := func(reason string) { skipped = append(skipped, skippedFile{Path: rel, Reason: reason}) }
		switch {
		case walkErr != nil:
			if path == root {
				return walkErr
			}
			skip("could not be read: " + walkErr.Error())
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		case entry.IsDir():
			if reason := scope.refuses(path); reason != "" {
				skip(reason)
				return filepath.SkipDir
			}
			return nil
		case entry.Type()&fs.ModeSymlink != 0:
			skip("a symbolic link, which is not followed")
		case !entry.Type().IsRegular():
			skip("not a regular file")
		default:
			info, err := entry.Info()
			if err != nil {
				skip("could not be read: " + err.Error())
				break
			}
			if problem := bundlePathProblem(rel); problem != "" {
				skip(problem)
				break
			}
			if reason := scope.refuses(realPath(path)); reason != "" {
				skip(reason)
				break
			}
			switch {
			case info.Size() > maxSessionAttachmentBytes:
				return fmt.Errorf("%s: %w, and a folder is kept whole or not at all", rel, errAttachmentTooLarge)
			case info.Size() == 0:
				skip("empty, and Orbit keeps no empty file")
			default:
				file, err := os.Open(path)
				if err != nil {
					skip("could not be read: " + err.Error())
					break
				}
				file.Close()
				files = append(files, folderFile{path: path, rel: rel})
			}
		}
		if len(files)+len(skipped) > fileBundleMaxFiles {
			return fmt.Errorf("this folder holds more than %d files, the most one bundle holds, so nothing was uploaded. "+
				"Upload the directory you meant, or the files that matter", fileBundleMaxFiles)
		}
		return nil
	})
	return files, skipped, err
}

// bundlePathProblem says why the server would refuse a path in a bundle (apiserver files.service.ts assertBundlePath and
// MAX_BUNDLE_PATH_CHARS), and "" when it would not. Bytes that are not UTF-8 are here too: JSON would change them, and
// two such names could become one path.
func bundlePathProblem(rel string) string {
	switch {
	case !utf8.ValidString(rel):
		return "a name that is not valid UTF-8"
	case utf8.RuneCountInString(rel) > fileBundleMaxPathChars:
		return fmt.Sprintf("a path longer than %d characters", fileBundleMaxPathChars)
	case strings.ContainsFunc(rel, func(r rune) bool { return r == '\\' || unicode.IsControl(r) }):
		return "a backslash or a control character in its name"
	}
	return ""
}

// fetchedFilePath is where a fetched file goes: under its own id, because two files of a folder can share a name and a
// fetch of one must not take the place of the other. In the uploads directory, so that it is outside the checkout and
// is a path a reply may link.
func fetchedFilePath(sessionID, fileID, name string) (string, error) {
	if err := validatePathSegmentID(fileID); err != nil {
		return "", fmt.Errorf("the server named a file %q: %w", fileID, err)
	}
	return filepath.Join(uploadsDir(sessionID), "files", fileID, uploadFileName(name, fileID)), nil
}

// fetchFile is file_fetch. A bundle's bytes are its manifest, which is saved and read out: a judge usually wants a few
// of a folder's files, and picks them from this (docs/orbit-files-design.md §6, item 2).
func fetchFile(t *Transport, tool fileToolContext, id string) (fileAnswer, error) {
	var out fileAnswer
	sessionID, err := fileSessionOf(tool, "file_fetch")
	if err != nil {
		return out, err
	}
	if err := validatePathSegmentID(id); err != nil {
		return out, fmt.Errorf("file_fetch: %w", err)
	}
	file, err := t.describeFile(sessionID, id)
	if err != nil {
		return out, fileCallError("file_fetch "+id, err)
	}
	dest, err := fetchedFilePath(sessionID, file.id(), file.Name)
	if err != nil {
		return out, fmt.Errorf("file_fetch %s: %w", id, err)
	}
	ctx, cancel := tool.callContext()
	defer cancel()
	sum, size, err := t.downloadFile(ctx, sessionID, file.id(), dest, file.SHA256)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return out, fileTimeoutError("file_fetch "+id, tool.callTimeout)
	}
	if err != nil {
		return out, fileCallError("file_fetch "+id, err)
	}
	out = answerFor(file)
	out.SHA256, out.SizeBytes, out.Path = sum, size, dest
	if file.Kind == "bundle" {
		data, err := os.ReadFile(dest)
		if err != nil {
			return out, fmt.Errorf("file_fetch %s: %w", id, err)
		}
		var manifest fileBundleManifest
		if err := json.Unmarshal(data, &manifest); err != nil {
			return out, fmt.Errorf("file_fetch %s: the bundle's manifest cannot be read: %w", id, err)
		}
		for _, entry := range manifest.Files {
			entry.Link = fileLink(entry.ID)
			out.Files = append(out.Files, entry)
		}
	}
	return out, nil
}

// listSessionFiles is file_list: one task's, one session's or one evidence version's, and this session's when none is
// named. Rows come from the server as they are and are given their links here.
func listSessionFiles(t *Transport, tool fileToolContext, taskID, sessionID, evidenceID string) (json.RawMessage, error) {
	filter := url.Values{}
	for key, value := range map[string]string{"taskId": taskID, "sessionId": sessionID, "evidenceId": evidenceID} {
		if value != "" {
			filter.Set(key, value)
		}
	}
	if len(filter) == 0 {
		if tool.sessionID == "" {
			return nil, errors.New("file_list: name a taskId, sessionId or evidenceId: there is no Orbit session here (ORBIT_SESSION_ID) to list")
		}
		filter.Set("sessionId", tool.sessionID)
	}
	raw, err := t.listFiles(filter)
	if err != nil {
		return nil, fileCallError("file_list", err)
	}
	var listed struct {
		Files     []sessionFile `json:"files"`
		Truncated bool          `json:"truncated"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		return nil, fmt.Errorf("file_list: %w", err)
	}
	answers := make([]fileAnswer, 0, len(listed.Files))
	for _, file := range listed.Files {
		answers = append(answers, answerFor(file))
	}
	answer := map[string]interface{}{"files": answers}
	if listed.Truncated {
		answer["note"] = "Showing the newest " + strconv.Itoa(len(answers)) + " files; there are more."
	}
	return json.Marshal(answer)
}

// ── The descriptors ─────────────────────────────────────────────────────────────────────────────

// fileToolDescriptors is the agent-facing contract of the file tools. Not gated on orchestration: keeping and reading
// back your own files is no power over anybody else's session.
func fileToolDescriptors(obj func(map[string]interface{}, ...string) map[string]interface{}) []map[string]interface{} {
	return []map[string]interface{}{
		{
			"name": "file_upload",
			"description": "Keep a file or a folder in Orbit instead of in the repository: this is where screenshots and " +
				"reports go. It returns id, sha256, sizeBytes and link, an orbit-attachment: link to put in a reply as " +
				"![name](link) for an image or [name](link) for anything else. A directory becomes one folder bundle with " +
				"a manifest of its relative paths, and each file is listed with its own id. Symbolic links are not " +
				"followed; they, empty files and anything else that cannot be kept are listed under skipped. One file may " +
				"be 25 MiB and a folder " + strconv.Itoa(fileBundleMaxFiles) + " files; a folder over either is refused whole.",
			"inputSchema": obj(map[string]interface{}{
				"path": map[string]interface{}{
					"type": "string",
					"description": "The file or directory, absolute or relative to the working directory. Its real " +
						"location, links resolved, has to be inside this session's checkout or its uploads directory, " +
						"as with a file a reply links; anywhere else is refused, so copy a file there first.",
				},
				"taskId": map[string]interface{}{
					"type": "string",
					"description": "The task this session is running; leaving it out means the same. A file stays with the " +
						"session that uploads it and counts as that session's task, so any other task's id is refused. To " +
						"give a file to another task as an input, use task_create's attachmentIds; a folder goes file by " +
						"file, by the ids in its files list.",
				},
				"label": map[string]interface{}{
					"type":        "string",
					"maxLength":   fileLabelMaxChars,
					"description": "What this is, in a few words, kept with the file. On a directory it is the bundle's.",
				},
			}, "path"),
			"annotations": map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
		},
		{
			"name": "file_fetch",
			"description": "Download one of this session's files into its uploads directory, outside the repository, and " +
				"return its absolute path. The bytes are checked against the sha256 Orbit holds. Given a folder bundle's " +
				"id, it saves the manifest and lists the bundle's files with their ids, so that you fetch only the ones " +
				"you need.",
			"inputSchema": obj(map[string]interface{}{
				"id": map[string]interface{}{
					"type":        "string",
					"description": "The file's or the bundle's id, as file_upload or file_list gave it.",
				},
			}, "id"),
			// It changes nothing in Orbit, and it does write a file here.
			"annotations": map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
		},
		{
			"name": "file_list",
			"description": "List the files of one task, one session or one evidence version, newest first, each with id, " +
				"sha256, sizeBytes and link. With none of the three it lists this session's. A task's files are its inputs " +
				"and what the sessions that ran it kept with file_upload. A folder is one row of kind bundle: file_fetch it " +
				"for the files inside. This says what exists; file_fetch reads only this session's own files.",
			"inputSchema": obj(map[string]interface{}{
				"taskId":     map[string]interface{}{"type": "string", "description": "List this task's files."},
				"sessionId":  map[string]interface{}{"type": "string", "description": "List this session's files."},
				"evidenceId": map[string]interface{}{"type": "string", "description": "List this evidence version's files."},
			}),
			"annotations": map[string]interface{}{"readOnlyHint": true},
		},
	}
}
