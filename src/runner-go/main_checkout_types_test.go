package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"testing"
)

// The main checkout Git contract, held from the Go side: src/shared/src/main-checkout-git.fixture.json
// is also read by src/shared/src/mainCheckoutGit.spec.ts, so a field, code or name that drifts on
// either side fails one of the two. This test reads the fixture and never writes it.

const mainCheckoutFixturePath = "../shared/src/main-checkout-git.fixture.json"

func readMainCheckoutFixture(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(mainCheckoutFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fx map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	return fx
}

// roundTrip decodes raw into a fresh *T refusing unknown fields (every field the fixture writes has
// a Go twin), encodes it again and requires the same JSON back (no field lost to a wrong omitempty).
func roundTrip[T any](t *testing.T, name string, raw json.RawMessage) T {
	t.Helper()
	var v T
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	again, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var want, got interface{}
	_ = json.Unmarshal(raw, &want)
	_ = json.Unmarshal(again, &got)
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("%s does not survive a Go round trip:\nwant %s\ngot  %s", name, raw, again)
	}
	return v
}

// fixtureFingerprint is the contract's definition, written out for the test only.
func fixtureFingerprint(head string, files []MainCheckoutFile) string {
	sorted := append([]MainCheckoutFile(nil), files...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Path < sorted[j].Path }) // Go compares bytes
	if head == "" {
		head = "-"
	}
	h := sha256.New()
	h.Write([]byte("mc1\nhead " + head + "\n"))
	for _, f := range sorted {
		h.Write([]byte(f.Status + " " + f.ContentHash + " " + f.Path + "\x00"))
	}
	return "mc1:" + head + ":" + hex.EncodeToString(h.Sum(nil))
}

func TestMainCheckoutContractNames(t *testing.T) {
	fx := readMainCheckoutFixture(t)
	var capability string
	var limit int
	var kinds, codes []string
	var notices map[string]string
	for key, dst := range map[string]interface{}{
		"capability": &capability, "fileLimit": &limit, "actionKinds": &kinds, "refusalCodes": &codes, "noticeKinds": &notices,
	} {
		if err := json.Unmarshal(fx[key], dst); err != nil {
			t.Fatalf("%s: %v", key, err)
		}
	}
	if capability != mainCheckoutGitCapabilityV1 {
		t.Errorf("capability %q, fixture %q", mainCheckoutGitCapabilityV1, capability)
	}
	if limit != mainCheckoutFileLimit {
		t.Errorf("file limit %d, fixture %d", mainCheckoutFileLimit, limit)
	}
	if want := []string{mainCheckoutMove, mainCheckoutCommit, mainCheckoutPush, mainCheckoutRescue}; !reflect.DeepEqual(kinds, want) {
		t.Errorf("kinds %v, fixture %v", want, kinds)
	}
	if !reflect.DeepEqual(codes, mainCheckoutRefusalCodes) {
		t.Errorf("codes %v, fixture %v", mainCheckoutRefusalCodes, codes)
	}
	if want := map[string]string{"changed": noticeMainCheckoutChanged, "result": noticeMainCheckoutActionResult}; !reflect.DeepEqual(notices, want) {
		t.Errorf("notice kinds %v, fixture %v", want, notices)
	}
}

func TestMainCheckoutFixtureParsesIntoGoTypes(t *testing.T) {
	fx := readMainCheckoutFixture(t)

	snap := roundTrip[MainCheckoutSnapshot](t, "snapshot", fx["snapshot"])
	if snap.FileCount != len(snap.Files) || snap.Truncated {
		t.Errorf("snapshot counts: %d files, fileCount %d, truncated %v", len(snap.Files), snap.FileCount, snap.Truncated)
	}
	if !sort.SliceIsSorted(snap.Files, func(i, j int) bool { return snap.Files[i].Path < snap.Files[j].Path }) {
		t.Errorf("snapshot files are not in byte order")
	}
	if got := fixtureFingerprint(snap.Head, snap.Files); got != snap.Fingerprint {
		t.Errorf("snapshot fingerprint %s, computed %s", snap.Fingerprint, got)
	}
	trunc := roundTrip[MainCheckoutSnapshot](t, "truncatedSnapshot", fx["truncatedSnapshot"])
	if !trunc.Truncated || trunc.FileCount != mainCheckoutFileLimit {
		t.Errorf("truncated snapshot: %+v", trunc)
	}

	var vectors []json.RawMessage
	if err := json.Unmarshal(fx["fingerprints"], &vectors); err != nil {
		t.Fatal(err)
	}
	for i, raw := range vectors {
		v := roundTrip[struct {
			Head        string             `json:"head,omitempty"`
			Files       []MainCheckoutFile `json:"files"`
			Fingerprint string             `json:"fingerprint"`
		}](t, "fingerprints", raw)
		if got := fixtureFingerprint(v.Head, v.Files); got != v.Fingerprint {
			t.Errorf("vector %d: fixture %s, computed %s", i, v.Fingerprint, got)
		}
	}

	// A heartbeat repos[] entry: today's RepoHealthReport plus the new fields, nothing more.
	hb := roundTrip[struct {
		RepoHealthReport
		MainCheckoutHeartbeatFields
	}](t, "heartbeatRepo", fx["heartbeatRepo"])
	if hb.Fingerprint != snap.Fingerprint || hb.FileCount == nil || *hb.FileCount != len(snap.Files) {
		t.Errorf("heartbeat entry: %+v", hb.MainCheckoutHeartbeatFields)
	}

	roundTrip[MainCheckoutFileDiff](t, "diff", fx["diff"])
	roundTrip[MainCheckoutActionCommand](t, "command", fx["command"])
	notice := roundTrip[MainCheckoutChangedNotice](t, "changedNotice", fx["changedNotice"])
	if notice.NoticeKind != noticeMainCheckoutChanged {
		t.Errorf("changed notice kind %q", notice.NoticeKind)
	}

	var requests []json.RawMessage
	if err := json.Unmarshal(fx["requests"], &requests); err != nil {
		t.Fatal(err)
	}
	for _, raw := range requests {
		roundTrip[MainCheckoutActionRequest](t, "request", raw)
	}

	var results []struct {
		Name   string          `json:"name"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(fx["results"], &results); err != nil {
		t.Fatal(err)
	}
	known := map[string]bool{}
	for _, c := range mainCheckoutRefusalCodes {
		known[c] = true
	}
	statuses := map[string]bool{mainCheckoutDone: true, mainCheckoutPartial: true, mainCheckoutRefused: true, mainCheckoutWaiting: true}
	seen := map[string]bool{}
	for _, r := range results {
		res := roundTrip[MainCheckoutActionResult](t, r.Name, r.Result)
		if !statuses[res.Status] {
			t.Errorf("%s: status %q", r.Name, res.Status)
		}
		if (res.Status == mainCheckoutDone) != (res.Code == "") || (res.Code != "" && !known[res.Code]) {
			t.Errorf("%s: status %q with code %q", r.Name, res.Status, res.Code)
		}
		seen[res.Code] = true
	}
	for _, c := range mainCheckoutRefusalCodes {
		if !seen[c] {
			t.Errorf("no fixture result for %s", c)
		}
	}
}
