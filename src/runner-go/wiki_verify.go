package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// `orbit wiki verify`: how a session lets what it proposed into an Automatic space go live
// (contracts/wiki.contract.json `agentSurface.verify` and `reviewModes.verification`, criterion 7 revision 3).
//
// WHAT AN AUTOMATIC SPACE HOLDS BACK, THE SERVER DECIDES — BY ASKING A MODEL, NEVER BY ITSELF. Every op a
// session proposed into an Automatic space waits for a verdict, and nothing of it is live until one
// arrives. The Orbit server's own worker reads each op and the records it cites, asks the deployment's
// System model for the verdict, and applies it (`reviewModes.verification.servedBy`). This command asks
// the server to verify the ops the calling session proposed and waits for the verdicts: no model of the
// session's is asked anything, and nothing here decides a verdict.

// wikiVerifyPrecondition is contracts/wiki.contract.json `agentSurface.verify.precondition`, word for
// word, and wiki_verify_test.go holds the two equal. It leads the description for the reason
// wikiProposePrecondition leads wiki_propose's: the one thing a reader must not do here is the thing
// the mechanics make easy — decide a verdict itself.
const wikiVerifyPrecondition = "Verify only the ops this session proposed into an automatic space, and never " +
	"write a verdict yourself: each verdict is the System model's, read on the Orbit server against the op's own " +
	"sources, and a verdict that cannot be read is reported as nothing."

const wikiVerifyDescription = wikiVerifyPrecondition + " This is how what an automatic space holds back goes live: " +
	"it asks the Orbit server to verify the ops this session proposed that wait for their verification in --space, and " +
	"waits for the verdicts. The server's own worker reads each op and the text of each record it cites, asks the " +
	"deployment's System model whether it is supported, partial, unsupported or duplicate, and applies the answer: " +
	"supported as Auto and pushed, partial as Unreviewed, unsupported rejected with its reason, a duplicate's sources " +
	"added to the entry it duplicates. No model of this session's is asked. It exits non-zero when the wait runs out " +
	"with any op still without a verdict: those ops keep waiting, and the next run asks for them again."

// The contract's numbers this side needs (`reviewModes.rules`): a list page is asked for at a size the
// server grants.
const (
	wikiVerifyPageSize = 20
	// How often a run waiting on the server's own verification re-reads the list, and how long it waits in
	// all: as long as one verdict of a local model was ever allowed to take — decoding runs at tens of tokens a
	// second, three times slower when the GPU is shared — before what still waits counts as without a verdict.
	wikiVerifyServerPollInterval = 5 * time.Second
	wikiVerifyServerWait         = 15 * time.Minute
)

// What a run waiting on the server's own verification waits in all and how often it looks: the numbers
// above in the product, and a test's own where one drives the wait rather than the clock.
var (
	wikiVerifyServerWaitFor = wikiVerifyServerWait
	wikiVerifyServerPollFor = wikiVerifyServerPollInterval
)

// ── The server's two routes ─────────────────────────────────────────────────────────────────────

// wikiVerificationPage is `GET /api/runner/wiki/spaces/:id/verifications`, as far as this command reads it.
type wikiVerificationPage struct {
	SpaceID string `json:"spaceId"`
	Mode    string `json:"mode"`
	// ServedBy is "server" where this deployment's own worker verifies the ops that wait (contract
	// `reviewModes.verification.servedBy`): the list carries no items then — the material is not this
	// session's to read — and Waiting says how many of its ops are waiting, so this command can wait for them
	// to clear.
	ServedBy string `json:"servedBy"`
	Waiting  int    `json:"waiting"`
}

// ── One run ─────────────────────────────────────────────────────────────────────────────────────

// wikiVerifySummary is what a run did, and what `--json` prints.
type wikiVerifySummary struct {
	SpaceID  string              `json:"spaceId"`
	Mode     string              `json:"mode"`
	Looked   int                 `json:"looked"`
	Verified int                 `json:"verified"`
	Failed   int                 `json:"failed"`
	Failures []wikiVerifyFailure `json:"failures"`
	// ServedBy is "server": the run waited for the deployment's own worker to verify (contract
	// `reviewModes.verification.servedBy`), the verdicts are the server's, and Looked and Verified count the
	// ops it was waiting on.
	ServedBy string `json:"servedBy,omitempty"`
}

type wikiVerifyFailure struct {
	OpID string `json:"opId"`
	Why  string `json:"why"`
}

// wikiVerifyDoor is where a verification reads the ops it waits on: the list on one route after the space,
// and the command an error there is said to have failed in.
type wikiVerifyDoor struct {
	route, command string
}

// wikiOwnVerifications is the door of the ops the calling session proposed (`orbit wiki verify`).
var wikiOwnVerifications = wikiVerifyDoor{route: "verifications", command: "orbit wiki verify"}

// wikiVerifyServedByServer reads the first page of the list to learn who verifies for this session (contract
// `reviewModes.verification.servedBy`): a page that says `servedBy: server` means the deployment's own worker
// verifies, which is the only verification this build waits for. The page is handed back for the wait.
func wikiVerifyServedByServer(t *Transport, sessionID, spaceID string) (wikiVerificationPage, bool, error) {
	raw, err := t.listWikiVerifications(wikiOwnVerifications.route, sessionID, spaceID, "", 1)
	if err != nil {
		return wikiVerificationPage{}, false, wikiCallError(wikiOwnVerifications.command, err)
	}
	var page wikiVerificationPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return page, false, fmt.Errorf("%s: the server's list is not the shape this build reads: %w", wikiOwnVerifications.command, err)
	}
	return page, page.ServedBy != "", nil
}

// waitForServerVerification waits for this deployment's own worker to verify the ops this session
// proposed (contract `reviewModes.verification.servedBy`): what `orbit wiki verify` does once the list
// answered `servedBy: server` — the ops are the wiki worker's to verify with the System model.
//
// IT ASKS ONCE FIRST (routes.request): one queued job per session and space, so this is a no-op where the
// submission's own trigger already made one, and the request the only way back for ops whose job was lost
// (a space verified while the worker was down, a job swept after too many infra failures). Then it reads the
// list until nothing of the session's waits (waiting reaches zero) or the wait runs out: what is still
// waiting then is reported as an op left without a verdict, and the command exits non-zero so whatever
// asked for it tries again.
func waitForServerVerification(t *Transport, door wikiVerifyDoor, sessionID, spaceID string, page wikiVerificationPage, summary *wikiVerifySummary, progress io.Writer) error {
	summary.ServedBy = "server"
	summary.Mode = page.Mode
	summary.Looked = page.Waiting
	fmt.Fprintf(progress, "The server verifies the ops this session proposed in space %s: waiting for %s to be verified "+
		"(no model is asked here).\n", spaceID, wikiCount(summary.Looked, "op", "ops"))
	if _, err := t.requestWikiVerification(sessionID, spaceID); err != nil {
		return wikiCallError(door.command, err)
	}
	deadline := time.Now().Add(wikiVerifyServerWaitFor)
	for {
		raw, err := t.listWikiVerifications(door.route, sessionID, spaceID, "", wikiVerifyPageSize)
		if err != nil {
			return wikiCallError(door.command, err)
		}
		var now wikiVerificationPage
		if err := json.Unmarshal(raw, &now); err != nil {
			return fmt.Errorf("%s: the server's list is not the shape this build reads: %w", door.command, err)
		}
		if now.ServedBy == "" {
			// The server stopped saying it verifies while this ran (it was replaced by one from before it
			// verified itself), and this run says so rather than reporting verdicts it never waited for.
			return wikiVerifyServerTooOld(spaceID)
		}
		summary.Mode = now.Mode
		if now.Waiting == 0 {
			summary.Verified = summary.Looked
			fmt.Fprintf(progress, "The server verified %s in space %s.\n", wikiCount(summary.Verified, "op", "ops"), spaceID)
			return nil
		}
		if time.Now().After(deadline) {
			summary.Failed = now.Waiting
			summary.Failures = append(summary.Failures, wikiVerifyFailure{OpID: "", Why: fmt.Sprintf(
				"still waiting for the server's verdict after %s, so nothing was reported for it", wikiVerifyServerWaitFor)})
			return fmt.Errorf("%s left without a verdict after %s: the server is still verifying them, and the next run "+
				"tries them again", wikiCount(now.Waiting, "op was", "ops were"), wikiVerifyServerWaitFor)
		}
		time.Sleep(wikiVerifyServerPollFor)
	}
}

// wikiVerifyServerTooOld is a server whose list does not say it verifies itself: one from before the
// server's own verification, or one that still leaves it to the session. This build has no verifier of its
// own to fall back to, so nothing is verified until the server does it.
func wikiVerifyServerTooOld(spaceID string) error {
	return fmt.Errorf("%s: this Orbit server does not verify what this session proposed in space %s itself (its list "+
		"says nothing of servedBy: server): it is too old for this orbit, which no longer verifies with a model of its "+
		"own. Nothing was verified; the ops keep waiting. Upgrade the Orbit server, then run it again",
		wikiOwnVerifications.command, spaceID)
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────

func cliWikiVerify(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki verify")
	space := fs.String("space", "", "the automatic space this session proposed into")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	spaceID := strings.TrimSpace(*space)
	if spaceID == "" {
		return fmt.Errorf("--space is required: the automatic space this session proposed into")
	}
	if err := validatePathSegmentID(spaceID); err != nil {
		return fmt.Errorf("--space %w", err)
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	progress := out
	if *jsonOut {
		progress = io.Discard
	}
	page, served, err := wikiVerifyServedByServer(t, ctx.sessionID, spaceID)
	if err != nil {
		return err
	}
	if !served {
		return wikiVerifyServerTooOld(spaceID)
	}
	summary := wikiVerifySummary{SpaceID: spaceID, Failures: []wikiVerifyFailure{}}
	runErr := waitForServerVerification(t, wikiOwnVerifications, ctx.sessionID, spaceID, page, &summary, progress)
	if *jsonOut {
		raw, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		if err := writeCLIRawJSON(out, raw, true); err != nil {
			return err
		}
	} else {
		fmt.Fprintln(out, describeWikiVerifySummary(summary))
	}
	if runErr != nil {
		return runErr
	}
	if summary.Failed > 0 {
		return fmt.Errorf("%s left without a verdict: they keep waiting, and the next run tries them again",
			wikiCount(summary.Failed, "op was", "ops were"))
	}
	return nil
}

func describeWikiVerifySummary(s wikiVerifySummary) string {
	line := fmt.Sprintf("Verified %d of %d by the server's own worker in space %s", s.Verified, s.Looked, s.SpaceID)
	if s.Failed > 0 {
		line += fmt.Sprintf("; %d still waiting for its verdict", s.Failed)
	}
	return line + ". No model of this session's was asked."
}
