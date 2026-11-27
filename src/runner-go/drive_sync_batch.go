package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"time"
)

// What a sync sends less of (docs/drive-directory-sync-design.md, "Sending what is not there yet" and "Many small
// files"). Before it uploads, the sync hashes a file's 8 MiB chunks here and asks the server which of them this account
// already holds (`POST /runner/drive/chunks/held`), and sends only the others: a renamed or copied file, a second run
// after a stop, or a file whose first chunks are unchanged sends that much less. Small files go together: one question,
// one staging and one `POST /runner/drive/batch` for up to driveSyncBatchFiles of them, about one request a file where a
// file alone takes seven. A server without these routes is answered by driveSyncBatched, and the sync then sends file by
// file as it always did (uploadDriveSyncFile).

const (
	// The most files, and bytes of them, one batch carries. The bytes are held in memory while the batch goes up.
	driveSyncBatchFiles = 64
	driveSyncBatchBytes = 32 * 1024 * 1024
	// The most chunks one held question names (the server's own limit).
	driveSyncHeldMax = 1000
)

// driveSyncChunk is one 8 MiB (or shorter, last) chunk of a local file.
type driveSyncChunk struct {
	driveChunk
	offset int64
}

// driveSyncUnit is what one worker sends at a time: up to driveSyncBatchFiles small files, or one large one.
type driveSyncUnit []driveSyncLocal

// driveSyncUnits groups the files to send: a file of one chunk or less goes in a batch with others, and a larger one is
// a unit of its own.
func driveSyncUnits(uploads []driveSyncLocal) []driveSyncUnit {
	var units []driveSyncUnit
	var batch driveSyncUnit
	var batchBytes int64
	flush := func() {
		if len(batch) > 0 {
			units = append(units, batch)
		}
		batch, batchBytes = nil, 0
	}
	for _, local := range uploads {
		if local.size > driveChunkSize {
			units = append(units, driveSyncUnit{local})
			continue
		}
		if len(batch) == driveSyncBatchFiles || batchBytes+local.size > driveSyncBatchBytes {
			flush()
		}
		batch = append(batch, local)
		batchBytes += local.size
	}
	flush()
	return units
}

// driveSyncBatched says whether the server has the held question and the batch route; one that answers 404 is older,
// and the sync sends file by file.
func driveSyncBatched(ctx context.Context, t *Transport) bool {
	var answer struct {
		Held []string `json:"held"`
	}
	err := driveWrite(ctx, t, "/chunks/held", map[string]interface{}{"chunks": []driveChunk{}}, &answer)
	if err != nil && !isTransportHTTPStatus(err, http.StatusNotFound) {
		logln("drive sync: could not ask which chunks Drive holds; sending file by file:", err)
	}
	return err == nil
}

// driveHeld is the set of these chunks' hashes this account already holds.
func driveHeld(ctx context.Context, t *Transport, chunks []driveChunk) (map[string]bool, error) {
	held := map[string]bool{}
	for start := 0; start < len(chunks); start += driveSyncHeldMax {
		end := start + driveSyncHeldMax
		if end > len(chunks) {
			end = len(chunks)
		}
		refs := make([]map[string]interface{}, 0, end-start)
		for _, c := range chunks[start:end] {
			refs = append(refs, map[string]interface{}{"sha256": c.SHA256, "size": c.Size})
		}
		var answer struct {
			Held []string `json:"held"`
		}
		if err := driveWrite(ctx, t, "/chunks/held", map[string]interface{}{"chunks": refs}, &answer); err != nil {
			return nil, err
		}
		for _, sha := range answer.Held {
			held[sha] = true
		}
	}
	return held, nil
}

// driveSyncHashed is a local file as the sync read it: what it was then, its chunks, and for a small file its bytes.
type driveSyncHashed struct {
	local  driveSyncLocal
	info   os.FileInfo
	chunks []driveSyncChunk
	data   []byte
}

// hashDriveSyncFile reads a file once for its chunks' hashes, keeping its bytes when it is small enough to batch.
func hashDriveSyncFile(scope localFileScope, local driveSyncLocal) (driveSyncHashed, error) {
	file, info, err := scope.openRegular(local.path, false)
	if err != nil {
		return driveSyncHashed{}, err
	}
	defer file.Close()
	hashed := driveSyncHashed{local: local, info: info}
	keep := info.Size() <= driveChunkSize
	buf := make([]byte, driveChunkSize)
	var offset int64
	for {
		n, err := io.ReadFull(file, buf)
		if err == io.EOF {
			break
		}
		if err != nil && err != io.ErrUnexpectedEOF {
			return driveSyncHashed{}, err
		}
		digest := sha256.Sum256(buf[:n])
		hashed.chunks = append(hashed.chunks, driveSyncChunk{
			driveChunk: driveChunk{Index: len(hashed.chunks), Size: n, SHA256: hex.EncodeToString(digest[:])},
			offset:     offset,
		})
		if keep {
			hashed.data = append(hashed.data, buf[:n]...)
		}
		offset += int64(n)
	}
	return hashed, nil
}

// changedSince says whether a file is no longer what the sync read.
func changedSince(local driveSyncLocal, info os.FileInfo) bool {
	after, err := os.Stat(local.path)
	return err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime())
}

// chunkBytes is one chunk of a hashed file: from memory for a small file, read again from disk for a large one.
func chunkBytes(scope localFileScope, hashed driveSyncHashed, chunk driveSyncChunk) ([]byte, error) {
	if hashed.data != nil {
		return hashed.data[chunk.offset : chunk.offset+int64(chunk.Size)], nil
	}
	file, _, err := scope.openRegular(hashed.local.path, false)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data := make([]byte, chunk.Size)
	if _, err := file.ReadAt(data, chunk.offset); err != nil {
		return nil, err
	}
	return data, nil
}

// driveBatchResult is the server's answer for one file of a batch.
type driveBatchResult struct {
	Path    string `json:"path"`
	OK      bool   `json:"ok"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Status  int    `json:"status"`
}

// uploadDriveSyncUnit sends one unit and answers each of its files' outcome: "" when it went up, else why not. A file
// that changed while it was read is read once more; a transient failure, or a chunk Drive no longer held by the commit,
// sends again, up to driveSyncFileAttempts.
func uploadDriveSyncUnit(ctx context.Context, t *Transport, opts driveSyncOptions, writer driveWriter, progress *driveSyncProgress, unit driveSyncUnit) map[string]string {
	scope := newSessionFileScope(opts.sessionID)
	outcome := map[string]string{}
	pending := append(driveSyncUnit{}, unit...)
	changedOnce := map[string]bool{}
	key := "unit:" + unit[0].rel
	for attempt := 1; len(pending) > 0; attempt++ {
		if ctx.Err() != nil {
			for _, local := range pending {
				outcome[local.rel] = "Stopped before it finished."
			}
			break
		}
		var unitBytes int64
		for _, local := range pending {
			unitBytes += local.size
		}
		counter := &driveProgress{size: unitBytes}
		progress.update(func(p *driveSyncProgress) { p.inFlight[key], p.current = counter, pending[0].rel })
		retry, transient := sendDriveSyncUnit(ctx, t, opts, writer, scope, counter, pending, outcome, changedOnce)
		progress.update(func(p *driveSyncProgress) {
			delete(p.inFlight, key)
			for _, local := range pending {
				if reason, done := outcome[local.rel]; done && reason == "" {
					p.done++
					p.bytesDone += local.size
				}
			}
		})
		pending = retry
		if len(pending) == 0 {
			break
		}
		if transient && attempt >= driveSyncFileAttempts {
			for _, local := range pending {
				outcome[local.rel] = fmt.Sprintf("Couldn't reach Orbit after %d tries.", driveSyncFileAttempts)
			}
			break
		}
		if transient {
			select {
			case <-ctx.Done():
			case <-time.After(time.Duration(attempt) * time.Second):
			}
		}
	}
	return outcome
}

// sendDriveSyncUnit is one try at a unit: it writes what it settles into outcome, and answers the files to try again
// and whether that is because Orbit could not be reached.
func sendDriveSyncUnit(ctx context.Context, t *Transport, opts driveSyncOptions, writer driveWriter, scope localFileScope,
	counter *driveProgress, pending driveSyncUnit, outcome map[string]string, changedOnce map[string]bool) (driveSyncUnit, bool) {
	var retry driveSyncUnit
	again := func(local driveSyncLocal, reason string) {
		if changedOnce[local.rel] {
			outcome[local.rel] = reason
			return
		}
		changedOnce[local.rel] = true
		retry = append(retry, local)
	}
	// failed is a request that did not go through: tried again when Orbit could not be reached, else each file fails
	// with the reason.
	failed := func(err error, locals driveSyncUnit) (driveSyncUnit, bool) {
		if driveSyncTransient(err) {
			return append(retry, locals...), true
		}
		for _, local := range locals {
			outcome[local.rel] = driveSyncReason(err)
		}
		return retry, false
	}

	// Read and hash every file of the unit.
	var hashed []driveSyncHashed
	var refs []driveChunk
	for _, local := range pending {
		h, err := hashDriveSyncFile(scope, local)
		if err != nil {
			outcome[local.rel] = driveSyncReason(err)
			continue
		}
		hashed = append(hashed, h)
		for _, c := range h.chunks {
			refs = append(refs, c.driveChunk)
		}
	}
	if len(hashed) == 0 {
		return retry, false
	}

	// Ask what Drive holds, and send the rest into one staging bound to no file.
	held, err := driveHeld(ctx, t, refs)
	if err != nil {
		return failed(err, driveSyncLocalsOf(hashed))
	}
	var stagingID string
	sent := map[string]bool{}
	next := 0
	for _, h := range hashed {
		for _, c := range h.chunks {
			if held[c.SHA256] || sent[c.SHA256] {
				counter.add(int64(c.Size))
				continue
			}
			if stagingID == "" {
				var staging struct{ ID string }
				if err := driveWrite(ctx, t, "/stagings", map[string]interface{}{}, &staging); err != nil {
					return failed(err, driveSyncLocalsOf(hashed))
				}
				stagingID = staging.ID
			}
			data, err := chunkBytes(scope, h, c)
			if err != nil {
				again(h.local, driveSyncChangedReason)
				continue
			}
			route := fmt.Sprintf("/stagings/%s/chunks/%d", url.PathEscape(stagingID), next)
			if _, err := t.driveChunkCall(ctx, http.MethodPut, route, data, c.SHA256, 0, counter); err != nil {
				if driveDoorFailure(err).Code == "DRIVE_CHUNK_SHA256_MISMATCH" {
					again(h.local, driveSyncChangedReason)
					continue
				}
				return failed(err, driveSyncLocalsOf(hashed))
			}
			next++
			sent[c.SHA256] = true
		}
	}

	// Commit every file still whole in one batch, each with its modification time.
	var items []map[string]interface{}
	var committing []driveSyncHashed
	for _, h := range hashed {
		if _, settled := outcome[h.local.rel]; settled || driveSyncContains(retry, h.local.rel) {
			continue
		}
		commitID, err := randomUUID()
		if err != nil {
			outcome[h.local.rel] = err.Error()
			continue
		}
		chunks := make([]driveChunk, 0, len(h.chunks))
		for _, c := range h.chunks {
			chunks = append(chunks, c.driveChunk)
		}
		items = append(items, map[string]interface{}{
			"path": path.Join(opts.dest, h.local.rel), "commitId": commitID, "chunks": chunks,
			"mtime": h.info.ModTime().UTC().Format(time.RFC3339Nano),
		})
		committing = append(committing, h)
	}
	if len(items) == 0 {
		return retry, false
	}
	body := map[string]interface{}{"items": items, "writer": writer}
	if stagingID != "" {
		body["stagingId"] = stagingID
	}
	var answer struct {
		Results []driveBatchResult `json:"results"`
	}
	attempts := 0
	err = retryIdempotentWhile(ctx, func(ctx context.Context) error {
		attempts++
		return driveWrite(ctx, t, "/batch", body, &answer)
	}, func(err error) bool { return driveSyncTransient(err) && attempts < driveSyncFileAttempts })
	if err != nil {
		return failed(err, driveSyncLocalsOf(committing))
	}
	for i, h := range committing {
		if i >= len(answer.Results) {
			outcome[h.local.rel] = "Orbit did not answer for this file."
			continue
		}
		result := answer.Results[i]
		switch {
		case result.OK && changedSince(h.local, h.info):
			again(h.local, driveSyncChangedReason)
		case result.OK:
			outcome[h.local.rel] = ""
		case result.Code == "DRIVE_CHUNK_NOT_HELD":
			// Swept between the question and the commit: the next try sends it.
			again(h.local, "Drive no longer held part of it, and sending it again did not land.")
		default:
			outcome[h.local.rel] = result.Message
		}
	}
	return retry, false
}

func driveSyncLocalsOf(hashed []driveSyncHashed) driveSyncUnit {
	out := make(driveSyncUnit, 0, len(hashed))
	for _, h := range hashed {
		out = append(out, h.local)
	}
	return out
}

func driveSyncContains(unit driveSyncUnit, rel string) bool {
	for _, local := range unit {
		if local.rel == rel {
			return true
		}
	}
	return false
}
