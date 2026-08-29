package main

import "encoding/json"

// A base SHA and its diff are one snapshot. When a clean worktree produces nil
// slices, omitempty would otherwise send the new base without clearing the old
// file list on the control plane. Keep the legacy omission for requests that do
// not carry a worktree snapshot, but encode explicit empty arrays whenever a
// baseSha identifies one.
func nonNilChangedFiles(files []ChangedFile) []ChangedFile {
	if files == nil {
		return []ChangedFile{}
	}
	return files
}

func nonNilFilePatches(patches []FilePatch) []FilePatch {
	if patches == nil {
		return []FilePatch{}
	}
	return patches
}

type turnCompleteRequestJSON TurnCompleteRequest

func (r TurnCompleteRequest) MarshalJSON() ([]byte, error) {
	if r.BaseSha == "" {
		return json.Marshal(turnCompleteRequestJSON(r))
	}
	return json.Marshal(struct {
		turnCompleteRequestJSON
		ChangedFiles []ChangedFile `json:"changedFiles"`
		ChangedDiff  []FilePatch   `json:"changedDiff"`
	}{
		turnCompleteRequestJSON: turnCompleteRequestJSON(r),
		ChangedFiles:            nonNilChangedFiles(r.ChangedFiles),
		ChangedDiff:             nonNilFilePatches(r.ChangedDiff),
	})
}

type diffResultRequestJSON DiffResultRequest

func (r DiffResultRequest) MarshalJSON() ([]byte, error) {
	if r.BaseSha == "" {
		return json.Marshal(diffResultRequestJSON(r))
	}
	return json.Marshal(struct {
		diffResultRequestJSON
		ChangedFiles []ChangedFile `json:"changedFiles"`
		ChangedDiff  []FilePatch   `json:"changedDiff"`
	}{
		diffResultRequestJSON: diffResultRequestJSON(r),
		ChangedFiles:          nonNilChangedFiles(r.ChangedFiles),
		ChangedDiff:           nonNilFilePatches(r.ChangedDiff),
	})
}

type runFinalizeRequestJSON RunFinalizeRequest

func (r RunFinalizeRequest) MarshalJSON() ([]byte, error) {
	if r.BaseSha == "" {
		return json.Marshal(runFinalizeRequestJSON(r))
	}
	return json.Marshal(struct {
		runFinalizeRequestJSON
		ChangedFiles []ChangedFile `json:"changedFiles"`
		ChangedDiff  []FilePatch   `json:"changedDiff"`
	}{
		runFinalizeRequestJSON: runFinalizeRequestJSON(r),
		ChangedFiles:           nonNilChangedFiles(r.ChangedFiles),
		ChangedDiff:            nonNilFilePatches(r.ChangedDiff),
	})
}
