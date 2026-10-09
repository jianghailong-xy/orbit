package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// The person's side of `orbit task`, `orbit project` and `orbit session`
// (docs/personal-access-token-design.md §7.3). While this process acts as its user (§7.2), each of
// those commands that has a user route answering it the way its runner route does calls that route,
// with the personal access token, on the token's own server — so `--json` prints the same shape
// either way. One with no such route, or one that acts for the session it runs in, is refused before
// anything is read or sent, and says what to use instead. Nothing falls back to the runner's
// credential: cliTransport, which every command acting as the machine gets it from, refuses while
// the CLI acts as the person.

// userModeActions is how each command runs as the person, keyed by its words after `orbit`: "" for one
// that calls its user route, and otherwise why it does not and what to use instead. The three families
// are here whole (TestUserModeCoversEveryTaskProjectAndSessionCommand), beside the person's own
// commands; every other command acts as the machine, and runs as nobody else (userModeUnported).
var userModeActions = map[string]string{
	"login": "", "logout": "", "whoami": "", "api": "",

	"task list":              "",
	"task labels":            "",
	"task get":               "",
	"task attribution":       "",
	"task evidence-list":     "",
	"task evidence-submit":   "",
	"task create":            "",
	"task create-batch":      "",
	"task update":            "",
	"task reopen":            "",
	"task delete":            "",
	"task start":             "",
	"task comment":           "",
	"task progress":          "",
	"task dependency-graph":  "",
	"task dependency-add":    "",
	"task dependency-remove": "",
	"task batch-pin": "no user route re-pins tasks in bulk; re-pin them one at a time with " +
		"`orbit task update TASK_ID --provider SLUG --model MODEL`",
	"task evidence-decide": "a decision on completion evidence is an independent session's, made from inside " +
		"it (ORBIT_SESSION_ID), or the account owner's own in the Orbit app — never a personal access token's",
	"task request-confirmation": "a task's own run declares its work finished, from inside its session (ORBIT_SESSION_ID)",
	"task confirmation-review":  "a confirmation request is answered by the session it was handed to, from inside it (ORBIT_SESSION_ID)",
	"task confirmation-return":  "a confirmation request is answered by the session it was handed to, from inside it (ORBIT_SESSION_ID)",
	"task await":                "a watch wakes the session that made it, and you are not one; poll `orbit task get TASK_ID` instead",

	"project get":             "",
	"project crossings":       "",
	"project resolve-blocker": "",
	// Runs as the person, and unlike the rest it is the door's OTHER side there: the skip is the
	// account owner's decision, so a terminal with nobody to ask is exactly the case where the write
	// goes straight through (the same reading `project resolve-blocker` gives a headless caller).
	"project skip-merge-check": "",
	"project merge-evidence":  "",
	"project create":          "",
	"project update":          "",
	"project delete":          "",
	"project ensure-coordinator": "it opens a coordinator for the session it runs in (ORBIT_SESSION_ID); open the " +
		"project's coordinator as yourself with `orbit api -X POST /api/projects/PROJECT_ID/coordinator`",
	"project send": "it delivers a message from the session it runs in (ORBIT_SESSION_ID); send yours to the " +
		"session `orbit project get` names as coordinatorSessionId, with `orbit session send`",
	"project request-start": "it asks the account owner as the project's coordinating session (ORBIT_SESSION_ID), " +
		"and starting a project is the owner's own press in the Orbit app",
	"project request-done": "it asks the account owner as the project's coordinating session (ORBIT_SESSION_ID), " +
		"and recording a project done is the owner's own press in the Orbit app",

	"session list":           "",
	"session search":         "",
	"session get":            "",
	"session send":           "",
	"session interrupt":      "",
	"session merge":          "",
	"session merge-receipt":  "",
	"session merge-receipts": "",
	"session end":            "",
	"session complete":       "",
	"session delete":         "",
	"session create": "the user route that starts a session answers with the whole session rather than the " +
		"receipt this command prints; call it with `orbit api -X POST /api/sessions --data " +
		`'{"prompt":"...","workspaceId":"..."}'` + "`",
	"session import": "it imports a transcript off this machine's disk through this machine's runner; import it " +
		"as yourself from the workspace's settings in the Orbit app, or with `orbit api -X POST /api/sessions/import`",
	"session await": "a watch wakes the session that made it, and you are not one; poll `orbit session get " +
		"SESSION_ID` instead",
	"session reply": "only the session a request was sent to answers it, from inside that session (ORBIT_SESSION_ID)",
}

// userModeUnported is why a command outside the three families does not run as the person.
const userModeUnported = "it acts with this machine's runner credential and has no form that acts as you yet, " +
	"and the runner's credential is never used in your place"

// userModeHint closes every refusal: what does run as the person.
const userModeHint = "`orbit api` calls the REST API as you, and `orbit capabilities --json` marks which commands run as you"

// userModeReason is "" for a command that runs as the person and otherwise why it does not.
func userModeReason(command string) string {
	reason, listed := userModeActions[command]
	if !listed {
		return userModeUnported
	}
	return reason
}

// refusedAsUser is how every command that does not run as the person says so. command is its words
// after `orbit`, or "" where the caller cannot name it.
func refusedAsUser(identity cliIdentity, command, reason string) error {
	what := "this command"
	if command != "" {
		what = "`orbit " + command + "`"
	}
	return fmt.Errorf("%s does not run as you (%s): %s.\n%s", what, identity.Reason, reason, userModeHint)
}

// userModeGate is a task, project or session command's first step, before anything is read or sent.
// Inside a session it says once on stderr that a personal access token on hand is ignored (§7.2); as
// the person it refuses a command of the family that does not run as them. A command missing from
// userModeActions is the dispatcher's to call unknown — or, added since, it reaches cliTransport,
// which refuses the person.
func userModeGate(command string) (cliIdentity, error) {
	identity := resolveCLIIdentity()
	noteUserTokenIgnored(identity, os.Stderr)
	if identity.Kind != identityUser {
		return identity, nil
	}
	if reason := userModeActions[command]; reason != "" {
		return identity, refusedAsUser(identity, command, reason)
	}
	return identity, nil
}

// capabilityAvailability is whether a command the capability document lists runs under this process's
// identity, and why not when it does not (§7.4). The document leaves out what an identity is never
// offered — a session's own commands at a terminal, the person's inside a session — and marks the rest.
func capabilityAvailability(identity cliIdentity, argv []string) (bool, string) {
	command := strings.Join(argv[1:], " ")
	switch command {
	case "login", "logout", "whoami":
		// They look after the login itself, whoever the CLI acts as.
		return true, ""
	case "api":
		if err := actingUser(identity); err != nil {
			return false, err.Error()
		}
		return true, ""
	}
	if identity.Kind == identityUser {
		if reason := userModeReason(command); reason != "" {
			return false, reason
		}
	}
	// A credential that is there decides who the CLI is even when it cannot be used (§7.2), and then
	// nothing that acts as it runs.
	if identity.Problem != "" {
		return false, identity.Problem
	}
	return true, ""
}

// userTransport sends a command's requests as the person: their token, on the user routes under /api,
// to the server the token belongs to and no other (userAPIRequest).
type userTransport struct {
	identity cliIdentity
}

// cliUserTransport is the person's transport while this process acts as its user, and nil while it acts
// as anybody else.
func cliUserTransport() (*userTransport, error) {
	return userTransportFor(resolveCLIIdentity())
}

// userTransportFor is identity's transport when it is the person, nil when it is anybody else, and the
// problem with the login when it is the person and cannot be used (§7.2: a login that is there
// decides, usable or not).
func userTransportFor(identity cliIdentity) (*userTransport, error) {
	if identity.Kind != identityUser {
		return nil, nil
	}
	if identity.Problem != "" {
		return nil, errors.New(identity.Problem)
	}
	return &userTransport{identity: identity}, nil
}

// do sends one request to path, a user route under /api, and answers with the body. A refusal comes
// back as the runner door's does — a *transportHTTPError, its path without /api — so a command reads
// its code and status unchanged; a 401 says what every command acting as the person says to one.
func (u *userTransport) do(method, path string, body interface{}) (json.RawMessage, error) {
	return u.doWithin(method, path, body, userAPITimeout)
}

func (u *userTransport) doWithin(method, path string, body interface{}, timeout time.Duration) (json.RawMessage, error) {
	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = encoded
	}
	res, err := userAPIRequestWithin(u.identity.ServerURL, u.identity.token, method, "/api"+path, payload, timeout)
	if err != nil {
		return nil, err
	}
	if res.status < 200 || res.status >= 300 {
		refused := &transportHTTPError{method: method, path: path, statusCode: res.status, body: string(res.body)}
		if res.status == http.StatusUnauthorized {
			refused.explained = userTokenRefused(u.identity).Error()
		}
		return nil, refused
	}
	if len(bytes.TrimSpace(res.body)) == 0 {
		return nil, nil
	}
	return res.body, nil
}

// at sends one request about one object: collection/id, then rest. The id has to be one path segment.
func (u *userTransport) at(method, collection, id, rest string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	return u.do(method, collection+"/"+url.PathEscape(id)+rest, body)
}

// taskTransport is what the task commands send their requests through: the runner's routes with its
// credential (*Transport), or the user routes with the person's token (*userTransport).
type taskTransport interface {
	listTasks(status, listID, projectID string, labels []string, limit int, minPriority *int) (json.RawMessage, error)
	listTaskPage(status, listID, projectID string, labels []string, limit int, cursor string, minPriority *int) (json.RawMessage, string, error)
	labelSummary(listID string) (json.RawMessage, error)
	getTask(id string) (json.RawMessage, error)
	getTaskAttribution(id string) (json.RawMessage, error)
	listTaskEvidence(id string) (json.RawMessage, error)
	submitTaskEvidence(id, agentID, sessionID string, body interface{}) (json.RawMessage, error)
	createTask(agentID, sessionID string, body interface{}) (json.RawMessage, error)
	createTasksBatch(agentID, sessionID string, body interface{}) (json.RawMessage, error)
	updateTask(sessionID, id string, body interface{}) (json.RawMessage, error)
	deleteTask(id string) (json.RawMessage, error)
	startTask(id, triggerID string) (json.RawMessage, error)
	commentTask(id, agentID, sessionID, bodyText string) (json.RawMessage, error)
	getTaskProgress(id string) (json.RawMessage, error)
	reportTaskProgress(id string, body map[string]interface{}) (json.RawMessage, error)
	taskDependencyGraph(id string, maxDepth, maxNodes int) (json.RawMessage, error)
	addTaskDependency(id, dependsOnTaskID string) (json.RawMessage, error)
	removeTaskDependency(id, dependsOnTaskID string) (json.RawMessage, error)
}

// cliTaskTransport is where a task command sends its requests: the user routes while the CLI acts as
// the person, the runner's routes otherwise.
func cliTaskTransport() (taskTransport, error) {
	user, err := cliUserTransport()
	if err != nil {
		return nil, err
	}
	if user != nil {
		return user, nil
	}
	runner, err := cliTransport()
	if err != nil {
		return nil, err
	}
	return runner, nil
}

// listTasks is one page of rows. GET /tasks is the browser's whole list, descriptions included; the
// runner door answers a filtered list with the rows of the page query /tasks/page runs, so this asks
// that route for one page and answers with its rows — the array the runner door prints.
func (u *userTransport) listTasks(status, listID, projectID string, labels []string, limit int, minPriority *int) (json.RawMessage, error) {
	items, _, err := u.listTaskPage(status, listID, projectID, labels, limit, "", minPriority)
	return items, err
}

func (u *userTransport) listTaskPage(status, listID, projectID string, labels []string, limit int, cursor string, minPriority *int) (json.RawMessage, string, error) {
	q := taskListQuery(status, listID, projectID, labels, limit, cursor, minPriority)
	// The scope's tallies are the same on every page, and the runner door never counts them.
	q.Set("counts", "none")
	raw, err := u.do(http.MethodGet, "/tasks/page?"+q.Encode(), nil)
	if err != nil {
		return nil, "", err
	}
	var page taskPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil, "", fmt.Errorf("GET /api/tasks/page did not answer with a page of tasks: %w", err)
	}
	items, next := page.parts()
	return items, next, nil
}

func (u *userTransport) labelSummary(listID string) (json.RawMessage, error) {
	path := "/tasks/labels"
	if listID != "" {
		path += "?" + url.Values{"listId": {listID}}.Encode()
	}
	return u.do(http.MethodGet, path, nil)
}

func (u *userTransport) getTask(id string) (json.RawMessage, error) {
	return u.at(http.MethodGet, "/tasks", id, "", nil)
}

func (u *userTransport) getTaskAttribution(id string) (json.RawMessage, error) {
	return u.at(http.MethodGet, "/tasks", id, "/attribution", nil)
}

func (u *userTransport) listTaskEvidence(id string) (json.RawMessage, error) {
	return u.at(http.MethodGet, "/tasks", id, "/evidence", nil)
}

// submitTaskEvidence names the source session in the body, where the runner door reads it from the
// acting session's header.
func (u *userTransport) submitTaskEvidence(id, _, sessionID string, body interface{}) (json.RawMessage, error) {
	fields := map[string]interface{}{"sourceSessionId": sessionID}
	if given, ok := body.(map[string]interface{}); ok {
		for key, value := range given {
			fields[key] = value
		}
	}
	return u.at(http.MethodPost, "/tasks", id, "/evidence", fields)
}

// The person's writes name no acting agent or session — they are the person's own, recorded with the
// token they used — so the attribution the runner door takes from headers has nothing to carry here.

func (u *userTransport) createTask(_, _ string, body interface{}) (json.RawMessage, error) {
	return u.do(http.MethodPost, "/tasks", body)
}

func (u *userTransport) createTasksBatch(_, _ string, body interface{}) (json.RawMessage, error) {
	return u.do(http.MethodPost, "/tasks/batch-create", body)
}

func (u *userTransport) updateTask(_, id string, body interface{}) (json.RawMessage, error) {
	return u.at(http.MethodPatch, "/tasks", id, "", body)
}

func (u *userTransport) deleteTask(id string) (json.RawMessage, error) {
	return u.at(http.MethodDelete, "/tasks", id, "", nil)
}

// startTask is named and resent exactly as the runner door's start is (Transport.startTask).
func (u *userTransport) startTask(id, triggerID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	if triggerID == "" {
		return nil, fmt.Errorf("refusing to start task %s unnamed: a run request without a triggerId cannot be retried safely", id)
	}
	body := map[string]string{"triggerId": triggerID}
	return deliverRunRequest(func() (json.RawMessage, error) {
		return u.at(http.MethodPost, "/tasks", id, "/execute", body)
	})
}

func (u *userTransport) commentTask(id, _, _, bodyText string) (json.RawMessage, error) {
	return u.at(http.MethodPost, "/tasks", id, "/comments", map[string]string{"body": bodyText})
}

func (u *userTransport) getTaskProgress(id string) (json.RawMessage, error) {
	return u.at(http.MethodGet, "/tasks", id, "/progress", nil)
}

func (u *userTransport) reportTaskProgress(id string, body map[string]interface{}) (json.RawMessage, error) {
	return u.at(http.MethodPost, "/tasks", id, "/progress", body)
}

func (u *userTransport) taskDependencyGraph(id string, maxDepth, maxNodes int) (json.RawMessage, error) {
	q := url.Values{}
	if maxDepth > 0 {
		q.Set("maxDepth", strconv.Itoa(maxDepth))
	}
	if maxNodes > 0 {
		q.Set("maxNodes", strconv.Itoa(maxNodes))
	}
	rest := "/dependency-graph"
	if len(q) > 0 {
		rest += "?" + q.Encode()
	}
	return u.at(http.MethodGet, "/tasks", id, rest, nil)
}

func (u *userTransport) addTaskDependency(id, dependsOnTaskID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(dependsOnTaskID); err != nil {
		return nil, fmt.Errorf("prerequisite task id: %w", err)
	}
	return u.at(http.MethodPost, "/tasks", id, "/dependencies", map[string]string{"dependsOnTaskId": dependsOnTaskID})
}

func (u *userTransport) removeTaskDependency(id, dependsOnTaskID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(dependsOnTaskID); err != nil {
		return nil, fmt.Errorf("prerequisite task id: %w", err)
	}
	return u.at(http.MethodDelete, "/tasks", id, "/dependencies/"+url.PathEscape(dependsOnTaskID), nil)
}

// projectTransport is what the project commands send their requests through, as taskTransport is for
// the task commands.
type projectTransport interface {
	getProject(id string) (json.RawMessage, error)
	getProjectHandoffs(id, state string) (json.RawMessage, error)
	resolveProjectBlocker(projectID, blockerID string, body map[string]interface{}) (json.RawMessage, error)
	recordProjectMergeEvidence(id string, body map[string]interface{}) (json.RawMessage, error)
	createProject(sessionID, orchestrationToken string, body map[string]interface{}) (json.RawMessage, error)
	updateProject(sessionID, id string, body map[string]interface{}) (json.RawMessage, error)
	deleteProject(id string) (json.RawMessage, error)
	// skipIntegrationMergeCheck queues one landing with its merge check not run (§2.4 J-S5). The two
	// transports are the door's two sides and take one signature: the runner side sends the session
	// (the coordinator) and the card the owner answered, and the user side ignores both — that caller
	// IS the owner, so it has no session to act as and no card to name.
	skipIntegrationMergeCheck(sessionID, id, taskID, reason, approvalID string) (json.RawMessage, error)
}

// cliProjectTransport is where a project command sends its requests, as cliTaskTransport is for a task
// command.
func cliProjectTransport() (projectTransport, error) {
	user, err := cliUserTransport()
	if err != nil {
		return nil, err
	}
	if user != nil {
		return user, nil
	}
	runner, err := cliTransport()
	if err != nil {
		return nil, err
	}
	return runner, nil
}

func (u *userTransport) getProject(id string) (json.RawMessage, error) {
	return u.at(http.MethodGet, "/projects", id, "", nil)
}

func (u *userTransport) getProjectHandoffs(id, state string) (json.RawMessage, error) {
	rest := "/handoffs"
	if state != "" {
		rest += "?" + url.Values{"state": {state}}.Encode()
	}
	return u.at(http.MethodGet, "/projects", id, rest, nil)
}

func (u *userTransport) resolveProjectBlocker(projectID, blockerID string, body map[string]interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(blockerID); err != nil {
		return nil, err
	}
	return u.at(http.MethodPost, "/projects", projectID, "/blockers/"+url.PathEscape(blockerID)+"/resolve", body)
}

func (u *userTransport) recordProjectMergeEvidence(id string, body map[string]interface{}) (json.RawMessage, error) {
	return u.at(http.MethodPost, "/projects", id, "/acceptance/merge-evidence", body)
}

// skipIntegrationMergeCheck as the person: their own route, and no card. A skip is approved BY the
// account owner, so asking them to answer a card of their own would be asking them to agree with
// themselves — the server records them as the one who gave it either way.
func (u *userTransport) skipIntegrationMergeCheck(_, id, taskID, reason, _ string) (json.RawMessage, error) {
	if err := validatePathSegmentID(taskID); err != nil {
		return nil, err
	}
	return u.at(http.MethodPost, "/projects", id,
		"/tasks/"+url.PathEscape(taskID)+"/integration/skip-merge-check",
		map[string]interface{}{"reason": reason})
}

// createProject is the owner's own door, where naming a workspace needs no acting session: it is theirs
// to name.
func (u *userTransport) createProject(_, _ string, body map[string]interface{}) (json.RawMessage, error) {
	return u.do(http.MethodPost, "/projects", body)
}

func (u *userTransport) updateProject(_, id string, body map[string]interface{}) (json.RawMessage, error) {
	return u.at(http.MethodPatch, "/projects", id, "", body)
}

func (u *userTransport) deleteProject(id string) (json.RawMessage, error) {
	return u.at(http.MethodDelete, "/projects", id, "", nil)
}

// sessionTransport is what the session commands that run as the person send their requests through:
// the runner's routes with a session's, a service token's or the machine's credential (*Transport), or
// the user routes with the person's token (*userTransport).
type sessionTransport interface {
	listSessions(callerSessionID, orchestrationToken, query string) (json.RawMessage, error)
	searchSessions(callerSessionID, orchestrationToken, query string) (json.RawMessage, error)
	getSession(callerSessionID, orchestrationToken, id string) (json.RawMessage, error)
	sendSessionMessage(callerSessionID, orchestrationToken, id string, body interface{}) (json.RawMessage, error)
	interruptSession(callerSessionID, orchestrationToken, id string, body interface{}) (json.RawMessage, error)
	mergeSession(callerSessionID, orchestrationToken, id string, body interface{}, timeout time.Duration) (json.RawMessage, error)
	recordMergeReceipt(id string, body interface{}) (json.RawMessage, error)
	listMergeReceipts(id string, limit int) (json.RawMessage, error)
	endSession(callerSessionID, orchestrationToken, id string) (json.RawMessage, error)
	completeSession(callerSessionID, orchestrationToken, id string) (json.RawMessage, error)
	deleteSession(callerSessionID, orchestrationToken, id string) (json.RawMessage, error)
}

// sessionCommandTransport is where a session command sends its requests: the person's user routes when
// it acts as them, and otherwise the credential its context names (cliSessionTransport).
func sessionCommandTransport(ctx cliOrchestrationContext) (sessionTransport, error) {
	if ctx.user != nil {
		return ctx.user, nil
	}
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return nil, err
	}
	return t, nil
}

// The person is nobody's session, so the calling session and its credential the runner door is handed
// have nothing to carry on the user routes, and are not sent.

// listSessions answers with the compact rows the runner door does (GET /sessions is the browser's list,
// one view at a time and in another shape), filtered by the same query.
func (u *userTransport) listSessions(_, _ string, query string) (json.RawMessage, error) {
	return u.do(http.MethodGet, "/sessions/compact"+query, nil)
}

func (u *userTransport) searchSessions(_, _ string, query string) (json.RawMessage, error) {
	return u.do(http.MethodGet, "/sessions/search"+query, nil)
}

// getSession answers with the narrow detail the runner door does, rather than the browser's.
func (u *userTransport) getSession(_, _ string, id string) (json.RawMessage, error) {
	return u.at(http.MethodGet, "/sessions", id, "/compact", nil)
}

// sendSessionMessage sends on the person's door, which takes the message as `content` under a key it
// requires. --resume-if-ended goes to the person's resume, which sends to a session still live exactly
// as a plain send does. A request for a reply is refused: its answer comes back as a turn of the
// session that asked, and the person is not one.
func (u *userTransport) sendSessionMessage(_, _ string, id string, body interface{}) (json.RawMessage, error) {
	fields, _ := body.(map[string]interface{})
	if fields["expectReply"] == true {
		return nil, errors.New("--expect-reply needs a calling session: the answer comes back as a turn of the " +
			"session that asked, and you are not one. Send without it")
	}
	turn, err := userTurn(fields)
	if err != nil {
		return nil, err
	}
	rest := "/turns"
	if fields["resumeIfEnded"] == true {
		rest = "/resume"
	}
	return u.at(http.MethodPost, "/sessions", id, rest, turn)
}

// interruptSession stays bodyless for a plain interrupt, as on the runner door; a follow-up rides as the
// person's door takes a message.
func (u *userTransport) interruptSession(_, _ string, id string, body interface{}) (json.RawMessage, error) {
	var payload interface{}
	if fields, ok := body.(map[string]interface{}); ok {
		turn, err := userTurn(fields)
		if err != nil {
			return nil, err
		}
		payload = turn
	}
	return u.at(http.MethodPost, "/sessions", id, "/interrupt", payload)
}

// userTurn is a message as the person's session doors take it: the runner door's `message` as
// `content`, under the caller's key or a fresh one — those doors require the key the runner door mints
// when none is given.
func userTurn(fields map[string]interface{}) (map[string]interface{}, error) {
	key, _ := fields["clientTurnId"].(string)
	if key == "" {
		var err error
		if key, err = randomUUID(); err != nil {
			return nil, fmt.Errorf("cannot name this message (no entropy): %w", err)
		}
	}
	return map[string]interface{}{"content": fields["message"], "clientTurnId": key}, nil
}

// mergeSession waits as long as the runner door's does: the server holds a merge with --wait-seconds open.
func (u *userTransport) mergeSession(_, _ string, id string, body interface{}, timeout time.Duration) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	return u.doWithin(http.MethodPost, "/sessions/"+url.PathEscape(id)+"/merge", body, timeout)
}

func (u *userTransport) recordMergeReceipt(id string, body interface{}) (json.RawMessage, error) {
	return u.at(http.MethodPost, "/sessions", id, "/merge-receipts", body)
}

func (u *userTransport) listMergeReceipts(id string, limit int) (json.RawMessage, error) {
	rest := "/merge-receipts"
	if limit > 0 {
		rest += "?limit=" + strconv.Itoa(limit)
	}
	return u.at(http.MethodGet, "/sessions", id, rest, nil)
}

func (u *userTransport) endSession(_, _ string, id string) (json.RawMessage, error) {
	return u.at(http.MethodPost, "/sessions", id, "/end", nil)
}

func (u *userTransport) completeSession(_, _ string, id string) (json.RawMessage, error) {
	return u.at(http.MethodPost, "/sessions", id, "/complete", nil)
}

func (u *userTransport) deleteSession(_, _ string, id string) (json.RawMessage, error) {
	return u.at(http.MethodDelete, "/sessions", id, "", nil)
}
