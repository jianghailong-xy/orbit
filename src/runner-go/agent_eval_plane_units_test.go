package main

// The control plane's routes for the instruction-unit scenarios (agent_eval_scenarios_test.go, I1–I9): watches,
// notify, SubAgents, files, evidence, Settings and the wiki. Each answers in the shape the real server does, as far
// as the runner reads it, and records what the agent did in the ledger.

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// settleLocked ends the seed tasks whose time or turn has come.
func (p *evalPlane) settleLocked() {
	for _, task := range p.tasks {
		if task.Status == "DONE" || task.Status == "FAILED" || task.Status == "CANCELLED" {
			continue
		}
		if (task.DoneAfter > 0 && time.Since(p.started) >= task.DoneAfter) || (task.DoneAtTurn > 0 && p.turn >= task.DoneAtTurn) {
			task.Status = "DONE"
			p.record("task_finished", task.ID, "")
		}
	}
}

func (p *evalPlane) watchDoc(watch *evalWatchRow) map[string]interface{} {
	targets := []map[string]interface{}{}
	for range watch.Targets {
		targets = append(targets, map[string]interface{}{"targetKind": "TASK", "state": "PENDING"})
	}
	now := time.Now().UTC()
	return map[string]interface{}{"id": watch.ID, "state": watch.State, "action": watch.Action,
		"predicate": map[string]interface{}{"kind": "ALL", "over": "ALL_TARGETS", "leaf": "TERMINAL"},
		"createdAt": now.Format(time.RFC3339), "expiresAt": now.Add(24 * time.Hour).Format(time.RFC3339),
		"nextEvaluateAt": now.Add(30 * time.Second).Format(time.RFC3339), "lastEvaluatedAt": nil, "deadLetterCount": 0,
		"targets": targets, "matches": []interface{}{}}
}

// watchRoute is /runner/watches: a watch is made, read and cancelled, and never fires by itself.
func (p *evalPlane) watchRoute(w http.ResponseWriter, r *http.Request, parts []string, body map[string]interface{}) (int, string) {
	switch {
	case r.Method == http.MethodPost && len(parts) == 2:
		watch := &evalWatchRow{ID: evalPublicID(), Turn: p.turn, Action: asString(body["action"]), State: "ACTIVE"}
		if watch.Action == "" {
			watch.Action = "RESUME_SESSION"
		}
		if targets, ok := body["targets"].([]interface{}); ok {
			for _, t := range targets {
				watch.Targets = append(watch.Targets, asString(mapValue(t)["id"]))
			}
		}
		p.watches = append(p.watches, watch)
		p.record("watch_created", watch.ID, watch.Action)
		writeEvalJSON(w, 201, p.watchDoc(watch))
		return 201, ""
	case r.Method == http.MethodGet && len(parts) == 2:
		rows := []map[string]interface{}{}
		for _, watch := range p.watches {
			rows = append(rows, p.watchDoc(watch))
		}
		writeEvalJSON(w, 200, rows)
		return 200, ""
	case len(parts) >= 3:
		for _, watch := range p.watches {
			if watch.ID != parts[2] {
				continue
			}
			if r.Method == http.MethodPost && len(parts) == 4 && parts[3] == "cancel" {
				watch.State = "CANCELLED"
				p.record("watch_cancelled", watch.ID, "")
			}
			writeEvalJSON(w, 200, p.watchDoc(watch))
			return 200, ""
		}
		return p.refuse(w, 404, "WATCH_NOT_FOUND", "watch not found", "")
	}
	p.record("unexpected_route", "", r.Method+" "+r.URL.Path)
	return p.refuse(w, 404, "NOT_FOUND", "this eval's control plane has no "+r.Method+" "+r.URL.Path, "")
}

// worldWatch is the watch a wake turn names: the newest the agent made, or one the harness makes for it, so the wake's
// words name a watch the world holds either way.
func (p *evalPlane) worldWatch(targets ...string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := len(p.watches) - 1; i >= 0; i-- {
		if p.watches[i].Action != "NOTIFY_USER" {
			p.watches[i].State = "MATCHED"
			return p.watches[i].ID
		}
	}
	watch := &evalWatchRow{ID: evalPublicID(), Turn: p.turn, Action: "RESUME_SESSION", Targets: targets, State: "MATCHED", ByWorld: true}
	p.watches = append(p.watches, watch)
	return watch.ID
}

// evalSubagentResult is what every SubAgent run of the eval reports: the finding the delegate scenarios ask for.
const evalSubagentResult = "TestBillingExportRetries races a 9 ms goroutine against a 10 ms timeout, so a slow CI " +
	"machine misses the deadline about one run in ten. Waiting on the retry signal instead of a timer would fix it."

// subagentRoute is /runner/sessions/:id/subagents: the run is placed on another workspace (§10 of
// docs/subagent-design.md), so the runner follows its events instead of spawning an engine, and it ends at once.
func (p *evalPlane) subagentRoute(w http.ResponseWriter, r *http.Request, parts []string, body map[string]interface{}) (int, string) {
	switch {
	case r.Method == http.MethodPost && len(parts) == 4:
		id := evalPublicID()
		detail := "foreground"
		if body["background"] == true {
			detail = "background"
		}
		p.record("subagent_started", id, detail)
		writeEvalJSON(w, 201, map[string]interface{}{"runId": id, "status": "RUNNING",
			"decision": map[string]interface{}{"model": "eval-subagent-model"},
			"remote":   map[string]interface{}{"workspaceId": "eval-workspace", "workspaceName": "eval-remote"}})
		return 201, ""
	case r.Method == http.MethodGet && len(parts) == 6 && parts[5] == "events":
		result := evalSubagentResult
		writeEvalJSON(w, 200, map[string]interface{}{"events": []interface{}{}, "status": "DONE", "resultSummary": result})
		return 200, ""
	}
	// A detach, a stop, a rating: accepted, nothing to keep.
	writeEvalJSON(w, 200, map[string]interface{}{"ok": true})
	return 200, ""
}

// uploadFile is POST /runner/sessions/:id/files: the file kept, as the server's sessionFile.
func (p *evalPlane) uploadFile(w http.ResponseWriter) (int, string) {
	_, params, err := mime.ParseMediaType(p.contentType)
	if err != nil || params["boundary"] == "" {
		return p.refuse(w, 400, "INVALID_UPLOAD", "a file upload is multipart/form-data", "")
	}
	reader := multipart.NewReader(strings.NewReader(string(p.raw)), params["boundary"])
	name, mimeType, size, sum := "", "", 0, ""
	for {
		part, err := reader.NextPart()
		if err != nil {
			break
		}
		if part.FormName() == "file" {
			data, _ := io.ReadAll(part)
			name, mimeType, size = part.FileName(), part.Header.Get("Content-Type"), len(data)
			digest := sha256.Sum256(data)
			sum = hex.EncodeToString(digest[:])
		}
	}
	if name == "" {
		return p.refuse(w, 400, "INVALID_UPLOAD", "no file part", "")
	}
	id := evalPublicID()
	p.record("file_uploaded", id, name)
	writeEvalJSON(w, 201, map[string]interface{}{"id": id, "publicId": id, "kind": "FILE", "name": name, "mimeType": mimeType,
		"sizeBytes": size, "sha256": sum, "createdAt": time.Now().UTC().Format(time.RFC3339),
		"expiresAt": time.Now().UTC().Add(30 * 24 * time.Hour).Format(time.RFC3339)})
	return 201, ""
}

// evalSettings is the owner's preferences in the eval's world, as settingsView answers them
// (src/apiserver/src/owner-requests/settings-change.ts): a few rows of each tier.
var evalSettings = []map[string]interface{}{
	{"key": "theme", "tier": 1, "value": "system", "title": "Theme", "path": "Settings > General"},
	{"key": "translationEnabled", "tier": 1, "value": false, "title": "Translate messages", "path": "Settings > General > Translation"},
	{"key": "notifySessionFinished", "tier": 1, "value": true, "title": "Session finished", "path": "Settings > Notifications"},
	{"key": "notifyAgentMessage", "tier": 1, "value": true, "title": "Agent messages", "path": "Settings > Notifications"},
	{"key": "defaultEffort", "tier": 2, "value": "medium", "title": "Default effort", "path": nil},
	{"key": "enableOrchestration", "tier": 3, "value": false, "title": "Session orchestration", "path": "Settings > Agents"},
}

func evalSettingsView() []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(evalSettings))
	for _, row := range evalSettings {
		copyRow := map[string]interface{}{"link": "orbit-settings:" + asString(row["key"])}
		for k, v := range row {
			copyRow[k] = v
		}
		out = append(out, copyRow)
	}
	return out
}

// proposeSettings is POST /runner/settings-proposals: a SETTINGS_CHANGE card filed for the owner, answered later.
func (p *evalPlane) proposeSettings(w http.ResponseWriter, body map[string]interface{}) (int, string) {
	changes := mapValue(body["changes"])
	var keys []string
	var entries []map[string]interface{}
	for key, to := range changes {
		var row map[string]interface{}
		for _, s := range evalSettings {
			if s["key"] == key {
				row = s
			}
		}
		if row == nil {
			return p.refuse(w, 400, "SETTING_UNKNOWN", "\""+key+"\" is not a setting a session may propose a change to", "")
		}
		if row["tier"] == 3 && to == true {
			return p.refuse(w, 403, "SETTING_OWNER_ONLY", "This change to \""+asString(row["title"])+"\" gives agents more reach; only you can make it, in Settings.", "")
		}
		keys = append(keys, key)
		entries = append(entries, map[string]interface{}{"key": key, "from": row["value"], "to": to, "tier": row["tier"]})
	}
	sort.Strings(keys)
	id := evalPublicID()
	p.record("settings_proposed", id, strings.Join(keys, ","))
	writeEvalJSON(w, 201, map[string]interface{}{"id": id, "kind": "SETTINGS_CHANGE", "status": "PENDING",
		"title": "Change 1 setting?", "payload": map[string]interface{}{"changes": entries}})
	return 201, ""
}

// evalWikiPitfall is the one entry the eval's wiki holds: a pitfall anchored on the uploader, which a change to it
// should read first.
var evalWikiPitfall = wikiSearchHit{ID: "4WikiUploaderRetryPitfall", Kind: "pitfall",
	Title:   "A retried SFTP upload must use a new file name",
	Summary: "The bank's SFTP rejects a second upload of the same file name within 60 seconds, so a retry in uploader.Upload has to upload under a new name.",
	Trust:   "verified", AnchorState: "verified", Match: []string{"path"}, Score: 1,
	RecordedAt: "2026-10-02T09:00:00Z", ChangedAt: "2026-10-02T09:00:00Z"}

func evalWikiPitfallEntry() map[string]interface{} {
	return map[string]interface{}{"id": evalWikiPitfall.ID, "kind": evalWikiPitfall.Kind, "title": evalWikiPitfall.Title,
		"summary": evalWikiPitfall.Summary, "body": evalWikiPitfall.Summary + " Name the retry's file <name>.retry<n>.",
		"anchors": []interface{}{map[string]interface{}{"path": "uploader/upload.go", "state": "verified"}}}
}

// searchWiki is GET /runner/wiki/search: the pitfall for a search that names the uploader by path or word.
func (p *evalPlane) searchWiki(w http.ResponseWriter, q url.Values) (int, string) {
	terms := append([]string{q.Get("q")}, q["paths"]...)
	p.record("wiki_searched", "", strings.Join(terms, " | "))
	hits := []wikiSearchHit{}
	for _, term := range terms {
		if strings.Contains(strings.ToLower(term), "upload") {
			hits = append(hits, evalWikiPitfall)
			break
		}
	}
	writeEvalJSON(w, 200, wikiSearchAnswer{Q: q.Get("q"), Hits: hits})
	return 200, ""
}
