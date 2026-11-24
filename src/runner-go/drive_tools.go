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
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

const (
	documentsRoute     = "/runner/documents"
	documentsChunkSize = 8 * 1024 * 1024
	documentsTimeout   = 35 * time.Second
)

type documentsEntry struct {
	ID               string  `json:"id"`
	Kind             string  `json:"kind"`
	Name             string  `json:"name"`
	Path             string  `json:"path"`
	SizeBytes        int64   `json:"sizeBytes"`
	Mtime            *string `json:"mtime"`
	CurrentVersionID string  `json:"currentVersionId,omitempty"`
}

type documentsChunk struct {
	Index  int    `json:"idx"`
	Size   int    `json:"size"`
	SHA256 string `json:"sha256"`
}

type documentsCommitResult struct {
	EntryID    string `json:"entryId"`
	VersionID  string `json:"versionId"`
	NewVersion bool   `json:"newVersion"`
	SizeBytes  int64  `json:"sizeBytes"`
}

type documentsWriter struct {
	SessionID string `json:"sessionId,omitempty"`
}

// documentLink is a Documents file's link for a reply. Transcripts written before the rename carry orbit-drive:<id>,
// which every client still reads.
func documentLink(id string) string { return "orbit-document:" + id }

// documentsToolAliases are the Documents tools' names before the rename. They are still served, so an engine, a saved
// prompt or a schedule that calls drive_put keeps working, and never listed.
var documentsToolAliases = map[string]string{
	"drive_put":    "documents_put",
	"drive_get":    "documents_get",
	"drive_list":   "documents_list",
	"drive_move":   "documents_move",
	"drive_delete": "documents_delete",
}

// canonicalToolName is the name a call is served under: a Documents tool's old name is its new one.
func canonicalToolName(name string) string {
	if current, ok := documentsToolAliases[name]; ok {
		return current
	}
	return name
}

// documentsMountRelative recognizes the spellings of a mounted drive path: ~/Drive, /home/orbit/Drive and the mount; ~/Documents and ~/Files are
// ordinary local paths. Either root's drive/ is the drive whichever one this Pod has.
func documentsMountRelative(p string) (string, bool) {
	for _, root := range []string{"~/Drive", driveHomePath, driveMountPath,
		driveRootPath + "/drive", driveLegacyRootPath + "/drive"} {
		if p == root || strings.HasPrefix(p, root+"/") {
			return strings.TrimPrefix(p, root), true
		}
	}
	return p, false
}

func normalizeDocumentsPath(p string) (string, error) {
	p, _ = documentsMountRelative(p)
	for _, part := range strings.Split(p, "/") {
		if part == ".." {
			return "", errors.New("a drive path cannot contain a parent (..) segment")
		}
	}
	return path.Clean("/" + p), nil
}

func (s *mcpServer) callDocumentsTool(name string, args map[string]interface{}) (map[string]interface{}, bool) {
	switch name {
	case "documents_sync":
		if s.documentsOff {
			return toolResult(documentsOffMessage(name), true), true
		}
		raw, err := startDocumentsSyncJob(s.t, strings.TrimSpace(s.sessionID), getString(args, "localPath"), getString(args, "path"), getBool(args, "delete"))
		if err != nil {
			return toolResult(err.Error(), true), true
		}
		return toolResult(prettyJSON(raw), false), true
	case "documents_put", "documents_get", "documents_list", "documents_move", "documents_delete":
		if s.documentsOff {
			return toolResult(documentsOffMessage(name), true), true
		}
		progress := sessionDocumentsProgress(name, s.callToolUseID)
		raw, err := runDocumentsTool(s.t, fileToolContext{sessionID: strings.TrimSpace(s.sessionID), callTimeout: s.callTimeout, progress: progress}, name, args)
		progress.close()
		if err != nil {
			return toolResult(err.Error(), true), true
		}
		return toolResult(prettyJSON(raw), false), true
	default:
		return nil, false
	}
}

func runDocumentsTool(t *Transport, tool fileToolContext, name string, args map[string]interface{}) (json.RawMessage, error) {
	ctx, cancel := tool.callContext()
	defer cancel()
	pathArg := "path"
	if name == "documents_move" {
		pathArg = "from"
	}
	value := getString(args, pathArg)
	if value == "" && name != "documents_list" {
		return nil, fmt.Errorf("%s requires %s", name, pathArg)
	}
	p, err := normalizeDocumentsPath(value)
	if err != nil {
		return nil, err
	}

	writer := documentsWriter{SessionID: tool.sessionID}
	var answer interface{}
	switch name {
	case "documents_put":
		answer, err = putDocumentsFile(ctx, t, tool, getString(args, "localPath"), p, writer)
	case "documents_get":
		answer, err = getDocumentsFile(ctx, t, tool, p)
	case "documents_list":
		query := url.Values{"path": {p}}
		if cursor := getString(args, "cursor"); cursor != "" {
			query.Set("cursor", cursor)
		}
		page := struct {
			Entries    []documentsEntry `json:"entries"`
			NextCursor *string          `json:"nextCursor"`
		}{Entries: []documentsEntry{}}
		err = t.do(ctx, http.MethodGet, documentsRoute+"/list?"+query.Encode(), nil, &page, documentsTimeout)
		answer = page
	case "documents_move":
		value := getString(args, "to")
		if value == "" {
			return nil, errors.New("documents_move requires to")
		}
		to, pathErr := normalizeDocumentsPath(value)
		if pathErr != nil {
			return nil, pathErr
		}
		// As documents_put does, the destination's folder is made first: the door's rename, which the mount shares,
		// refuses a missing folder as rename(2) does.
		if parent := path.Dir(to); parent != "/" {
			if err := documentsWrite(ctx, t, "/mkdir", map[string]interface{}{"path": parent, "parents": true, "writer": writer}, nil); err != nil {
				return nil, err
			}
		}
		var entry json.RawMessage
		err = documentsWrite(ctx, t, "/rename", map[string]interface{}{"from": p, "to": to, "noReplace": false, "writer": writer}, &entry)
		answer = entry
	case "documents_delete":
		var deleted json.RawMessage
		err = documentsWrite(ctx, t, "/delete", map[string]interface{}{"path": p, "writer": writer}, &deleted)
		answer = deleted
	default:
		return nil, fmt.Errorf("unknown drive tool %q", name)
	}
	if err != nil {
		return nil, documentsToolError(name, err)
	}
	return json.Marshal(answer)
}

func documentsToolError(name string, err error) error {
	if documentsDisabledByServer(err) {
		return errors.New(documentsOffMessage(name))
	}
	if failure := documentsDoorFailure(err); failure.Message != "" {
		return fmt.Errorf("%s: %s", name, failure.Message)
	}
	return fmt.Errorf("%s: %w", name, err)
}

func documentsDoorFailure(err error) (failure struct{ Code, Message string }) {
	if httpErr, ok := err.(*transportHTTPError); ok {
		_ = json.Unmarshal([]byte(httpErr.body), &failure)
	}
	return failure
}

func documentsPathQuery(route, p string) string {
	return documentsRoute + route + "?" + url.Values{"path": {p}}.Encode()
}

func documentsStat(ctx context.Context, t *Transport, p string) (documentsEntry, error) {
	var entry documentsEntry
	err := t.do(ctx, http.MethodGet, documentsPathQuery("/stat", p), nil, &entry, documentsTimeout)
	return entry, err
}

func documentsWrite(ctx context.Context, t *Transport, route string, body map[string]interface{}, out interface{}) error {
	return t.do(ctx, http.MethodPost, documentsRoute+route, body, out, documentsTimeout)
}

func putDocumentsFile(ctx context.Context, t *Transport, tool fileToolContext, localPath, p string, writer documentsWriter) (interface{}, error) {
	sessionID, err := fileSessionOf(tool, "documents_put")
	if err != nil {
		return nil, err
	}
	if localPath == "" {
		return nil, errors.New("localPath is required")
	}
	file, info, err := newSessionFileScope(sessionID).openRegular(absPath(localPath), false)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if tool.progress != nil {
		tool.progress.setSize(info.Size())
	}
	result, entryPath, err := sendDocumentsFile(ctx, t, file, p, writer, tool.progress)
	if err != nil {
		return nil, err
	}
	return struct {
		ID         string `json:"id"`
		Path       string `json:"path"`
		Link       string `json:"link"`
		SizeBytes  int64  `json:"sizeBytes"`
		VersionID  string `json:"versionId"`
		NewVersion bool   `json:"newVersion"`
	}{result.EntryID, entryPath, documentLink(result.EntryID), result.SizeBytes, result.VersionID, result.NewVersion}, nil
}

// sendDocumentsFile writes an open local file to Documents path p, which documents_put and documents_sync share: the
// folder made first, the file created or overwritten (the previous version kept), its 8 MiB chunks staged, one commit.
// A non-nil progress counts the bytes as they go up. It answers the commit and the entry's Documents path.
func sendDocumentsFile(ctx context.Context, t *Transport, file io.Reader, p string, writer documentsWriter, progress *documentsProgress) (documentsCommitResult, string, error) {
	handleID, err := randomUUID()
	if err != nil {
		return documentsCommitResult{}, "", err
	}
	commitID, err := randomUUID()
	if err != nil {
		return documentsCommitResult{}, "", err
	}
	if parent := path.Dir(p); parent != "/" {
		if err := documentsWrite(ctx, t, "/mkdir", map[string]interface{}{"path": parent, "parents": true, "writer": writer}, nil); err != nil {
			return documentsCommitResult{}, "", err
		}
	}
	entry, err := documentsStat(ctx, t, p)
	mode := "OVERWRITE"
	if isTransportHTTPStatus(err, http.StatusNotFound) {
		err = documentsWrite(ctx, t, "/create", map[string]interface{}{"path": p, "handleId": handleID, "writer": writer}, &entry)
		mode = "CONTINUE"
	}
	if err != nil {
		return documentsCommitResult{}, "", err
	}
	if entry.Kind == "FOLDER" {
		return documentsCommitResult{}, "", fmt.Errorf("%s is a folder", p)
	}
	var staging struct{ ID string }
	if err := documentsWrite(ctx, t, "/stagings", map[string]interface{}{"entryId": entry.ID}, &staging); err != nil {
		return documentsCommitResult{}, "", err
	}
	chunks := []documentsChunk{}
	buf := make([]byte, documentsChunkSize)
	for {
		n, err := io.ReadFull(file, buf)
		if err == io.EOF {
			break
		}
		if err != nil && err != io.ErrUnexpectedEOF {
			return documentsCommitResult{}, "", err
		}
		digest := sha256.Sum256(buf[:n])
		chunk := documentsChunk{Index: len(chunks), Size: n, SHA256: hex.EncodeToString(digest[:])}
		route := fmt.Sprintf("/stagings/%s/chunks/%d", url.PathEscape(staging.ID), chunk.Index)
		if _, err := t.documentsChunkCall(ctx, http.MethodPut, route, buf[:n], chunk.SHA256, 0, progress); err != nil {
			return documentsCommitResult{}, "", err
		}
		chunks = append(chunks, chunk)
	}
	body := map[string]interface{}{
		"commitId": commitID, "entryId": entry.ID, "handleId": handleID, "mode": mode,
		"chunks": chunks, "stagingId": staging.ID, "writer": writer,
	}
	if mode == "CONTINUE" {
		body["baseVersionId"] = entry.CurrentVersionID
	}
	result, err := commitDocumentsFile(ctx, t, commitID, body)
	if err != nil {
		return documentsCommitResult{}, "", err
	}
	return result, entry.Path, nil
}

func commitDocumentsFile(ctx context.Context, t *Transport, commitID string, body map[string]interface{}) (documentsCommitResult, error) {
	var result documentsCommitResult
	attempts, uncertain := 0, false
	err := retryIdempotentWhile(ctx, func(ctx context.Context) error {
		attempts++
		result = documentsCommitResult{}
		err := documentsWrite(ctx, t, "/commit", body, &result)
		if err == nil && result.EntryID == "" {
			return errors.New("the drive returned an empty commit answer")
		}
		return err
	}, func(err error) bool {
		var refusal *transportHTTPError
		transient := !errors.As(err, &refusal) || refusal.statusCode >= http.StatusInternalServerError
		uncertain = uncertain || transient
		return transient && attempts < 4
	})
	if err == nil || !uncertain {
		return result, err
	}

	var receipt struct {
		Applied bool                  `json:"applied"`
		Result  documentsCommitResult `json:"result"`
	}
	if statusErr := t.do(ctx, http.MethodGet, documentsRoute+"/commits/"+commitID, nil, &receipt, documentsTimeout); statusErr == nil {
		if receipt.Applied {
			return receipt.Result, nil
		}
		return result, err
	}
	return result, fmt.Errorf("could not confirm whether commit %s applied: %w", commitID, err)
}

func getDocumentsFile(ctx context.Context, t *Transport, tool fileToolContext, p string) (interface{}, error) {
	sessionID, err := fileSessionOf(tool, "documents_get")
	if err != nil {
		return nil, err
	}
	var manifest struct {
		EntryID   string `json:"entryId"`
		SizeBytes int64  `json:"sizeBytes"`
		Chunks    []struct {
			documentsChunk
			Offset int64 `json:"offset"`
		} `json:"chunks"`
	}
	if err := t.do(ctx, http.MethodGet, documentsPathQuery("/manifest", p), nil, &manifest, documentsTimeout); err != nil {
		if documentsDoorFailure(err).Code == "DRIVE_NOT_A_FILE" {
			return nil, fmt.Errorf("%s is a folder. Use documents_list to see its entries", p)
		}
		return nil, err
	}
	if err := validatePathSegmentID(manifest.EntryID); err != nil {
		return nil, fmt.Errorf("drive entry %w", err)
	}

	if tool.progress != nil {
		tool.progress.setSize(manifest.SizeBytes)
	}
	filename := uploadFileName(path.Base(p), manifest.EntryID)
	dest, err := saveLocalFile(uploadsRootDir(), []string{decodeSessionID(sessionID), "drive", manifest.EntryID}, filename, func(w io.Writer) error {
		var size int64
		for i, chunk := range manifest.Chunks {
			digest, err := hex.DecodeString(chunk.SHA256)
			if err != nil || len(digest) != sha256.Size || chunk.Size <= 0 || chunk.Size > documentsChunkSize ||
				chunk.Index != i || chunk.Offset != size {
				return fmt.Errorf("invalid drive manifest chunk %d", i)
			}
			data, err := t.documentsChunkCall(ctx, http.MethodGet, "/chunks/"+chunk.SHA256, nil, "", chunk.Size, tool.progress)
			if err != nil {
				return err
			}
			actual := sha256.Sum256(data)
			if !bytes.Equal(actual[:], digest) || len(data) != chunk.Size {
				return fmt.Errorf("drive chunk %d failed its sha256 or size check", i)
			}
			if _, err := w.Write(data); err != nil {
				return err
			}
			size += int64(len(data))
		}
		if size != manifest.SizeBytes {
			return fmt.Errorf("downloaded %d bytes but the drive manifest said %d", size, manifest.SizeBytes)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return struct {
		Path      string `json:"path"`
		SizeBytes int64  `json:"sizeBytes"`
	}{dest, manifest.SizeBytes}, nil
}

// documentsChunkCall uses the same runner authentication as the file tools' raw transfers. A non-nil progress counts
// the bytes as they go up or come down.
func (t *Transport) documentsChunkCall(parent context.Context, method, route string, data []byte, digest string, size int, progress *documentsProgress) (_ []byte, err error) {
	noteTransportAttempt()
	defer func() { noteTransportResult(method, err) }()
	ctx, cancel := context.WithTimeout(parent, fileCallTimeout)
	defer cancel()
	route = documentsRoute + route
	var body io.Reader = bytes.NewReader(data)
	if progress != nil && method == http.MethodPut {
		body = countingReader{r: body, add: progress.add}
	}
	req, err := http.NewRequestWithContext(ctx, method, t.baseURL+"/api"+route, body)
	if err != nil {
		return nil, err
	}
	// A wrapped body hides its length from net/http; say it, so the chunk still goes up in one request.
	req.ContentLength = int64(len(data))
	if method == http.MethodPut {
		req.Header.Set("Content-Type", "application/octet-stream")
		req.Header.Set("X-Orbit-Chunk-Sha256", digest)
	}
	t.authorizeFileCall(req)
	resp, err := t.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, &transportHTTPError{method: method, path: route, statusCode: resp.StatusCode, body: string(body)}
	}
	if method == http.MethodPut {
		// Read the acknowledgement so a dropped response is a transfer failure.
		_, err := io.Copy(io.Discard, resp.Body)
		return nil, err
	}
	var got io.Reader = io.LimitReader(resp.Body, int64(size)+1)
	if progress != nil {
		got = countingReader{r: got, add: progress.add}
	}
	return io.ReadAll(got)
}
