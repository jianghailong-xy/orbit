package main

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strconv"
	"strings"
)

// What leaves this machine besides events, held to the same scrubber (docs/design/owner-request-secrets.md §7.2): a
// turn's completion and a run's finalize carry text the control plane stores (the result, the error, a shell turn's
// output) and patches it shows and merges from. Text is scrubbed; a file whose patch holds a value is left out of the
// patches, and the session told. A branch whose history holds a value is not merged or pushed.

// scrubTurnComplete is req with every held value scrubbed out of its text and every patch holding one left out. Done
// before the completion is journaled (turn_complete_journal.go) and again as it is sent.
func scrubTurnComplete(req TurnCompleteRequest, sessionID string) TurnCompleteRequest {
	r := runnerSecrets().scrubber()
	if r == nil {
		return req
	}
	req.Result, req.Error, req.Subtype = r.redact(req.Result), r.redact(req.Error), r.redact(req.Subtype)
	if req.ShellOutput != nil {
		out := r.redact(*req.ShellOutput)
		req.ShellOutput = &out
	}
	req.ChangedDiff = withoutSecretPatches(req.ChangedDiff, sessionID)
	return req
}

// scrubRunFinalize is scrubTurnComplete for a run's finalize.
func scrubRunFinalize(req RunFinalizeRequest, sessionID string) RunFinalizeRequest {
	r := runnerSecrets().scrubber()
	if r == nil {
		return req
	}
	req.Result, req.Error, req.Subtype = r.redact(req.Result), r.redact(req.Error), r.redact(req.Subtype)
	req.CaptureError = r.redact(req.CaptureError)
	req.ChangedDiff = withoutSecretPatches(req.ChangedDiff, sessionID)
	return req
}

// withoutSecretPatches leaves out of patches every file whose patch text (or preview) holds a held value, or whose
// patch names, on either side of its `index` line, a blob recorded as holding one (secret_taint.go) — what is left of
// a value once its grant has ended. The session is warned once per file; the file stays in the changed-file list with
// its counts.
func withoutSecretPatches(patches []FilePatch, sessionID string) []FilePatch {
	r := runnerSecrets().scrubber()
	if len(patches) == 0 {
		return patches
	}
	recorded := taintObjects("")
	if r == nil && len(recorded) == 0 {
		return patches
	}
	kept := make([]FilePatch, 0, len(patches))
	for _, patch := range patches {
		if (r != nil && (r.holds([]byte(patch.Patch)) || r.holds([]byte(patch.Preview)))) || patchNamesRecordedBlob(patch.Patch, recorded) {
			secretFileWarning(sessionID, patch.Path, "secret_patch_withheld", fmt.Sprintf(
				"%s holds the value of a secret the owner delivered to this runner, so Orbit left its diff out of what it reports. Remove the value from the file and from the branch's history.", patch.Path))
			continue
		}
		kept = append(kept, patch)
	}
	return kept
}

// patchNamesRecordedBlob reports whether a unified diff's `index <old>..<new>` line names a recorded blob on either
// side. The ids there are abbreviated, so they are matched as prefixes, and only at git's own minimum of 7 digits.
func patchNamesRecordedBlob(patch string, recorded map[string]string) bool {
	if len(recorded) == 0 {
		return false
	}
	for _, line := range strings.Split(patch, "\n") {
		if !strings.HasPrefix(line, "index ") {
			continue
		}
		ids, _, _ := strings.Cut(strings.TrimPrefix(line, "index "), " ")
		old, new, _ := strings.Cut(ids, "..")
		for _, short := range []string{old, new} {
			if len(short) < 7 || strings.Trim(short, "0") == "" {
				continue
			}
			for id := range recorded {
				if strings.HasPrefix(id, short) {
					return true
				}
			}
		}
	}
	return false
}

// secretHistoryScan is what a push or merge of tip would publish that holds a value r knows: every object reachable
// from tip and from none of exclude (blobs whatever their content, trees, commits and their messages, merges
// included) read whole through `git cat-file --batch`, so no diff option, binary file or user's diff configuration
// hides one. It returns the paths, as `git rev-list --objects` names them ("commit <id>" for a commit), and an error
// when the scan could not be completed: a caller refuses then, rather than push what it could not read.
func secretHistoryScan(repo, tip string, r *integrationOutputRedactor, exclude ...string) ([]string, error) {
	hits, err := secretHistoryObjects(repo, tip, r, exclude...)
	if err != nil {
		return nil, err
	}
	return objectHitPaths(hits), nil
}

// secretHistoryObjects is secretHistoryScan's objects: each one holding a value, with the path it goes by.
func secretHistoryObjects(repo, tip string, r *integrationOutputRedactor, exclude ...string) ([]objectHit, error) {
	if r == nil || tip == "" {
		return nil, nil
	}
	ids, names, err := listPublishedObjects(repo, tip, exclude...)
	if err != nil {
		return nil, err
	}
	hits, err := objectsHolding(repo, ids, r)
	if err != nil {
		return nil, err
	}
	for i := range hits {
		hits[i].path = names[hits[i].id]
	}
	return hits, nil
}

// listPublishedObjects is every object reachable from tip and from none of exclude, in order, with the path
// `git rev-list --objects` gives it ("" for commits and root trees). Exclude must be what the destination already
// has: a ref this push or merge would itself publish hides exactly what it publishes.
func listPublishedObjects(repo, tip string, exclude ...string) ([]string, map[string]string, error) {
	args := []string{"rev-list", "--objects", tip}
	var not []string
	for _, ref := range exclude {
		if ref == "" {
			continue
		}
		if _, err := git(repo, "rev-parse", "--verify", "--quiet", ref+"^{commit}"); err == nil {
			not = append(not, ref)
		}
	}
	if len(not) > 0 {
		args = append(args, append([]string{"--not"}, not...)...)
	}
	listed, err := git(repo, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("listing the objects of %s: %w", tip, err)
	}
	var ids []string
	names := map[string]string{}
	for _, line := range strings.Split(listed, "\n") {
		id, name, _ := strings.Cut(strings.TrimSpace(line), " ")
		if id == "" {
			continue
		}
		if _, seen := names[id]; !seen {
			ids = append(ids, id)
		}
		names[id] = name
	}
	return ids, names, nil
}

// objectHitPaths is the names of hits for a refusal: the path, or "commit <id>" for a commit's message.
func objectHitPaths(hits []objectHit) []string {
	paths := map[string]bool{}
	for _, hit := range hits {
		switch {
		case hit.kind == "commit":
			paths["commit "+hit.id] = true
		case hit.path != "":
			paths[hit.path] = true
		default:
			paths[hit.kind+" "+hit.id] = true
		}
	}
	out := make([]string, 0, len(paths))
	for p := range paths {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

type objectHit struct{ id, kind, path string }

// objectsHolding reads each object through one `git cat-file --batch` and returns those holding a value. Anything
// short of reading every object is an error.
func objectsHolding(repo string, ids []string, r *integrationOutputRedactor) ([]objectHit, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	cmd := exec.Command("git", "-C", repo, "cat-file", "--batch")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() {
		defer stdin.Close()
		for _, id := range ids {
			if _, err := io.WriteString(stdin, id+"\n"); err != nil {
				return
			}
		}
	}()
	reader := bufio.NewReaderSize(stdout, 64*1024)
	var hits []objectHit
	var readErr error
	for _, id := range ids {
		header, err := reader.ReadString('\n')
		if err != nil {
			readErr = fmt.Errorf("reading object %s: %w", id, err)
			break
		}
		fields := strings.Fields(header)
		if len(fields) != 3 {
			readErr = fmt.Errorf("object %s could not be read: %s", id, strings.TrimSpace(header))
			break
		}
		size, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil {
			readErr = fmt.Errorf("object %s: %w", id, err)
			break
		}
		content := make([]byte, size)
		if _, err := io.ReadFull(reader, content); err != nil {
			readErr = fmt.Errorf("reading object %s: %w", id, err)
			break
		}
		_, _ = reader.ReadByte()
		if r.holds(content) {
			hits = append(hits, objectHit{id: fields[0], kind: fields[1]})
		}
	}
	_, _ = io.Copy(io.Discard, reader)
	if err := cmd.Wait(); err != nil && readErr == nil {
		readErr = fmt.Errorf("git cat-file: %w", gitFailure(err))
	}
	if readErr != nil {
		return nil, readErr
	}
	return hits, nil
}

// secretPushRefusal is why tip may not be merged or pushed, "" when it may: its history holds a value this runner
// holds, or holds a commit recorded as holding one while a value was still known (secret_taint.go). A scan that
// cannot be completed refuses too.
func secretPushRefusal(repo, tip string, exclude ...string) string {
	if r := runnerSecrets().scrubber(); r != nil {
		paths, err := secretHistoryScan(repo, tip, r, exclude...)
		if err != nil {
			return "Refused: Orbit could not check what this would publish for the secrets the owner delivered to this runner, so it does not merge or push it: " +
				firstLine(err.Error())
		}
		if len(paths) > 0 {
			return secretHistoryRefusal(paths)
		}
	}
	if paths := taintedPaths(repo, tip, exclude...); len(paths) > 0 {
		return secretHistoryRefusal(paths)
	}
	return ""
}

// secretPushRefusalOf is secretPushRefusal for several tips published together, the first refusal winning.
func secretPushRefusalOf(repo string, tips []string, exclude ...string) string {
	for _, tip := range tips {
		if tip == "" {
			continue
		}
		if refusal := secretPushRefusal(repo, tip, exclude...); refusal != "" {
			return refusal
		}
	}
	return ""
}

// secretHistoryRefusal is why a merge or push of a branch holding a value was refused, and what to do about it.
func secretHistoryRefusal(paths []string) string {
	return fmt.Sprintf("Refused: the branch's commits add the value of a secret the owner delivered to this runner, in %s. "+
		"Orbit does not merge or push it. Remove the value from those files and from the branch's history "+
		"(rewrite or squash the commits that added it), then try again.", namePaths(paths))
}
