package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

// `orbit wiki verify`: an Automatic space's verifier (contracts/wiki.contract.json
// `agentSurface.verify` and `reviewModes.verification`, criterion 7 revision 3).
//
// WHAT AN AUTOMATIC SPACE HOLDS BACK, THIS DECIDES — BY ASKING A MODEL, NEVER BY ITSELF. Every op a
// session proposed into an Automatic space waits for a verdict, and nothing of it is live until one
// arrives. This command reads the ops the calling session proposed, hands each one — the entry, and
// the text of every record it cites — to a CLEAN Claude Code that calls the model the session's
// provider names, and reports the verdict it reads back. A verdict it cannot read is reported as
// nothing (Wikova's lesson: an answer that does not parse lets nothing through), and counts as a
// failure; that op keeps waiting for the next run.
//
// WHY A CLEAN CLAUDE CODE, AND WHAT CLEAN MEANS (project instructions, "本地模型与干净 Claude Code"):
// a session's own Claude Code carries some sixty thousand tokens of system prompt, tools, memory and
// CLAUDE.md into every request, which on the local model is a minute and a half of prefill before
// a word is read. `--bare` with an empty HOME and CLAUDE_CONFIG_DIR, no tools, no MCP server and no
// session file carries a few dozen. And the call is SEPARATE from the one that proposed the op: the
// verifier has not seen the proposer's reasoning, only what it claims and what it cites.
//
// THE TOKEN GOES THROUGH apiKeyHelper. A bare run authenticates with ANTHROPIC_API_KEY, which it
// sends as x-api-key alone — the local vLLM answers that 401 — and ignores the ANTHROPIC_AUTH_TOKEN
// the provider injected. An apiKeyHelper's output goes out as a Bearer token (and at times as
// x-api-key too, with the same value), so the helper prints ANTHROPIC_AUTH_TOKEN and the key
// variable is not handed to the child at all.

// wikiVerifyPrecondition is contracts/wiki.contract.json `agentSurface.verify.precondition`, word for
// word, and wiki_verify_test.go holds the two equal. It leads the description for the reason
// wikiProposePrecondition leads wiki_propose's: the one thing a reader must not do here is the thing
// the mechanics make easy — decide a verdict itself.
const wikiVerifyPrecondition = "Verify only the ops this session proposed into an automatic space, and never " +
	"write a verdict yourself: each verdict is the local model's, read from a separate clean call against the op's " +
	"own sources, and a verdict that cannot be read is reported as nothing."

const wikiVerifyDescription = wikiVerifyPrecondition + " This is how what an automatic space holds back goes live: " +
	"for each op this session proposed that waits for its verification in --space, one clean Claude Code call to the " +
	"model this session's provider names (ANTHROPIC_MODEL at ANTHROPIC_BASE_URL, with the token in ANTHROPIC_AUTH_TOKEN) " +
	"reads the entry and the text of each record it cites and answers supported, partial, unsupported or duplicate. " +
	"Each verdict is reported as soon as it is read, and the server applies it: supported as Auto and pushed, partial as " +
	"Unreviewed, unsupported rejected with its reason, a duplicate's sources added to the entry it duplicates. It stops " +
	"at the first 401 from the model's endpoint, and when the space is no longer automatic, and it exits non-zero when " +
	"any op it looked at was left without a verdict: those ops keep waiting, and the next run tries them again. The model " +
	"does not think unless --effort names a level."

// wikiVerifySystemPrompt is the whole system prompt the clean call carries: what the model is for,
// and the one shape its answer may take. The rest is in the prompt, one op at a time.
const wikiVerifySystemPrompt = "You verify proposed wiki entries against the records they cite. Judge only from " +
	"those records, never from what you know. Answer with one JSON object and nothing else."

// wikiVerifyVerdicts is contracts/wiki.contract.json `reviewModes.verification.verdicts`, in its order.
var wikiVerifyVerdicts = []string{"supported", "partial", "unsupported", "duplicate"}

// The contract's numbers this side needs (`reviewModes.rules`): a reason is cut to what the server
// stores, and a list page is asked for at a size the server grants.
const (
	wikiVerifyReasonMaxChars = 500
	wikiVerifyPageSize       = 20
	// A verdict from a local model is slow: decoding runs at tens of tokens a second, three times
	// slower when the GPU is shared. One op may take this long before it counts as a failure.
	wikiVerifyCallTimeout = 15 * time.Minute
)

// wikiVerifyEnvPass is what of the session's environment the clean Claude Code is handed besides
// its own HOME, CLAUDE_CONFIG_DIR and the endpoint and token: what a process needs to run at all,
// and the model window the provider declared. Everything else stays behind — the session's ORBIT_*
// (the child never reaches Orbit), its own Claude Code's CLAUDE_CODE_* (a messaging socket, a
// session id, the effort the provider declared for the session's own work), and ANTHROPIC_API_KEY,
// which a bare run would send as x-api-key.
var wikiVerifyEnvPass = []string{
	"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
	"ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
}

// wikiVerifyEfforts are the levels --effort takes: Claude Code's own, handed to it as
// CLAUDE_CODE_EFFORT_LEVEL.
var wikiVerifyEfforts = []string{"low", "medium", "high", "xhigh", "max"}

// wikiVerifyClaudeBinary is the Claude Code a test drives instead of the one this machine runs.
// Empty in the product.
var wikiVerifyClaudeBinary = ""

// wikiVerifyConfig is the model a run verifies with, as the session's provider named it, and the
// effort it was asked to think with: none unless --effort names one.
type wikiVerifyConfig struct {
	baseURL string
	token   string
	model   string
	effort  string
}

// wikiVerifyConfigFromEnv reads the endpoint, the token and the model the session's provider
// injected (contract `agentSurface.verify.model`). --model names another model on the same endpoint.
func wikiVerifyConfigFromEnv(model string) (wikiVerifyConfig, error) {
	cfg := wikiVerifyConfig{
		baseURL: strings.TrimRight(strings.TrimSpace(os.Getenv("ANTHROPIC_BASE_URL")), "/"),
		token:   strings.TrimSpace(os.Getenv("ANTHROPIC_AUTH_TOKEN")),
		model:   firstNonEmpty(strings.TrimSpace(model), strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))),
	}
	switch {
	case cfg.baseURL == "":
		return cfg, fmt.Errorf("orbit wiki verify calls the model this session's provider names, and this session's " +
			"environment names no endpoint (ANTHROPIC_BASE_URL): run it in a session on the local model's provider")
	case cfg.token == "":
		return cfg, fmt.Errorf("orbit wiki verify reads the model endpoint's token from ANTHROPIC_AUTH_TOKEN, which is " +
			"not set in this session: run it in a session on the local model's provider")
	case cfg.model == "":
		return cfg, fmt.Errorf("orbit wiki verify needs the model to verify with: ANTHROPIC_MODEL, which this " +
			"session's provider names, is not set — pass --model")
	}
	return cfg, nil
}

// ── The server's two routes ─────────────────────────────────────────────────────────────────────

// wikiVerificationPage is `GET /api/runner/wiki/spaces/:id/verifications`.
type wikiVerificationPage struct {
	SpaceID string                 `json:"spaceId"`
	Mode    string                 `json:"mode"`
	Items   []wikiVerificationItem `json:"items"`
	Next    string                 `json:"next"`
}

// wikiVerificationItem is one op that waits for its verdict, as the server hands it to a verifier.
type wikiVerificationItem struct {
	OpID    string `json:"opId"`
	Op      string `json:"op"`
	EntryID string `json:"entryId"`
	Entry   struct {
		Kind    string                 `json:"kind"`
		Title   string                 `json:"title"`
		Summary string                 `json:"summary"`
		Fields  map[string]interface{} `json:"fields"`
	} `json:"entry"`
	Sources []struct {
		Kind      string  `json:"kind"`
		Ref       string  `json:"ref"`
		Quote     *string `json:"quote"`
		Text      *string `json:"text"`
		Truncated bool    `json:"truncated"`
	} `json:"sources"`
	Similar []struct {
		ID     string `json:"id"`
		Kind   string `json:"kind"`
		Title  string `json:"title"`
		Status string `json:"status"`
	} `json:"similar"`
}

// wikiVerificationReport is `POST /api/runner/wiki/spaces/:id/verifications`'s answer.
type wikiVerificationReport struct {
	Mode     string                   `json:"mode"`
	Outcomes []map[string]interface{} `json:"outcomes"`
}

// ── One run ─────────────────────────────────────────────────────────────────────────────────────

// wikiVerifySummary is what a run did, and what `--json` prints.
type wikiVerifySummary struct {
	SpaceID     string              `json:"spaceId"`
	Mode        string              `json:"mode"`
	Model       string              `json:"model"`
	Looked      int                 `json:"looked"`
	Verified    int                 `json:"verified"`
	Supported   int                 `json:"supported"`
	Partial     int                 `json:"partial"`
	Unsupported int                 `json:"unsupported"`
	Duplicate   int                 `json:"duplicate"`
	Failed      int                 `json:"failed"`
	Failures    []wikiVerifyFailure `json:"failures"`
	Stopped     string              `json:"stopped,omitempty"`
	// What the verdicts cost, as Claude Code reported it: a maintenance run adds it to its own spend.
	Usage wikiModelUsage `json:"usage"`
}

type wikiVerifyFailure struct {
	OpID string `json:"opId"`
	Why  string `json:"why"`
}

// wikiVerifyAuthError is the model endpoint refusing the token: every op after it would be refused
// the same way, and a real Claude Code spends three minutes retrying each, so the run stops here.
type wikiVerifyAuthError struct{ detail string }

func (e *wikiVerifyAuthError) Error() string {
	return "the model endpoint refused the token (401): check the ANTHROPIC_AUTH_TOKEN this session's provider " +
		"injected; nothing more was verified. " + e.detail
}

// runWikiVerify verifies the ops the calling session proposed into spaceID, one at a time, and
// reports each verdict as soon as it is read. Progress lines go to progress as they happen.
func runWikiVerify(t *Transport, sessionID, spaceID string, cfg wikiVerifyConfig, max int, progress io.Writer) (wikiVerifySummary, error) {
	summary := wikiVerifySummary{SpaceID: spaceID, Model: cfg.model, Failures: []wikiVerifyFailure{}}
	claude, err := wikiVerifyClaudePath()
	if err != nil {
		return summary, err
	}
	if err := wikiVerifyEndpointUp(cfg.baseURL); err != nil {
		return summary, err
	}
	after := ""
	for {
		raw, err := t.listWikiVerifications(sessionID, spaceID, after, wikiVerifyPageSize)
		if err != nil {
			return summary, wikiCallError("orbit wiki verify", err)
		}
		var page wikiVerificationPage
		if err := json.Unmarshal(raw, &page); err != nil {
			return summary, fmt.Errorf("orbit wiki verify: the server's list is not the shape this build reads: %w", err)
		}
		summary.Mode = page.Mode
		if page.Mode != "automatic" {
			if len(page.Items) > 0 {
				summary.Stopped = fmt.Sprintf("the space is %s now, not automatic: its ops keep waiting for their verification "+
					"until the owner makes it automatic again", page.Mode)
			}
			return summary, nil
		}
		for _, item := range page.Items {
			if max > 0 && summary.Looked >= max {
				return summary, nil
			}
			summary.Looked++
			stop, err := verifyOneWikiOp(t, sessionID, spaceID, cfg, claude, item, &summary, progress)
			if err != nil {
				return summary, err
			}
			if stop {
				return summary, nil
			}
		}
		if page.Next == "" {
			return summary, nil
		}
		after = page.Next
	}
}

// verifyOneWikiOp asks the model about one op and reports what it said. It answers stop when the
// server says the space left Automatic, and an error only for what ends the whole run.
func verifyOneWikiOp(t *Transport, sessionID, spaceID string, cfg wikiVerifyConfig, claude string, item wikiVerificationItem, summary *wikiVerifySummary, progress io.Writer) (bool, error) {
	label := fmt.Sprintf("op %s (%s)", item.OpID, item.Entry.Title)
	fail := func(why string) {
		summary.Failed++
		summary.Failures = append(summary.Failures, wikiVerifyFailure{OpID: item.OpID, Why: why})
		fmt.Fprintf(progress, "%s: no verdict — %s\n", label, why)
	}
	candidates := wikiVerifyCandidates(item)
	ctx, cancel := context.WithTimeout(context.Background(), wikiVerifyCallTimeout)
	answer, usage, err := askWikiVerifier(ctx, claude, cfg, wikiVerifyPrompt(item, candidates))
	cancel()
	summary.Usage.InputTokens += usage.InputTokens
	summary.Usage.OutputTokens += usage.OutputTokens
	var auth *wikiVerifyAuthError
	if errors.As(err, &auth) {
		fail("the model endpoint answered 401")
		return false, err
	}
	if err != nil {
		fail(err.Error())
		return false, nil
	}
	verdict, err := parseWikiVerdict(answer, candidates)
	if err != nil {
		fail("the model's answer is not a verdict (" + err.Error() + "), so nothing was reported")
		return false, nil
	}
	body := map[string]interface{}{"opId": item.OpID, "verdict": verdict.Verdict, "reason": verdict.Reason, "model": cfg.model}
	if verdict.Verdict == "duplicate" {
		body["duplicateOf"] = verdict.DuplicateOf
	}
	raw, err := t.reportWikiVerifications(sessionID, spaceID, map[string]interface{}{"verdicts": []interface{}{body}})
	var report wikiVerificationReport
	if err != nil {
		// A refused verdict is an ANSWER: the door answers the first refusal's status with every
		// outcome in the body, as a refused proposal does.
		var httpErr *transportHTTPError
		if !errors.As(err, &httpErr) || json.Unmarshal([]byte(httpErr.body), &report) != nil || report.Outcomes == nil {
			return false, wikiCallError("orbit wiki verify", err)
		}
	} else if err := json.Unmarshal(raw, &report); err != nil {
		return false, fmt.Errorf("orbit wiki verify: the server's answer is not the shape this build reads: %w", err)
	}
	if len(report.Outcomes) == 0 {
		fail("the server recorded nothing for it")
		return false, nil
	}
	outcome := report.Outcomes[0]
	status, _ := outcome["status"].(string)
	if status == "refused" {
		message, _ := outcome["message"].(string)
		if report.Mode != "" && report.Mode != "automatic" {
			summary.Mode = report.Mode
			summary.Stopped = fmt.Sprintf("the space is %s now, not automatic: the rest keep waiting for their "+
				"verification until the owner makes it automatic again", report.Mode)
			fmt.Fprintf(progress, "%s: %s verdict not recorded — %s\n", label, verdict.Verdict, message)
			return true, nil
		}
		fail("the server refused the verdict: " + message)
		return false, nil
	}
	summary.Verified++
	switch verdict.Verdict {
	case "supported":
		summary.Supported++
	case "partial":
		summary.Partial++
	case "unsupported":
		summary.Unsupported++
	case "duplicate":
		summary.Duplicate++
	}
	fmt.Fprintf(progress, "%s: %s — %s\n", label, verdict.Verdict, describeWikiVerdictOutcome(outcome, verdict))
	if report.Mode != "" && report.Mode != "automatic" {
		// This verdict was the one that sent the space back to Tiered: nothing after it is recorded.
		summary.Mode = report.Mode
		summary.Stopped = fmt.Sprintf("this run's verdicts sent the space back to %s (too many of the latest were "+
			"unsupported): the owner has been told, and the rest keep waiting", report.Mode)
		return true, nil
	}
	return false, nil
}

func describeWikiVerdictOutcome(outcome map[string]interface{}, verdict wikiVerdict) string {
	status, _ := outcome["status"].(string)
	switch status {
	case "applied":
		trust, _ := outcome["trust"].(string)
		line := "applied as Unreviewed: shown, never pushed"
		if trust == "auto" {
			line = "applied as Auto, and pushed"
		}
		if spot, _ := outcome["spotCheck"].(bool); spot {
			line += "; drawn as a spot check for the owner"
		}
		return line
	case "rejected":
		return "rejected: " + verdict.Reason
	case "reinforced":
		if added, ok := outcome["reinforced"].(bool); ok && !added {
			return "a duplicate of " + verdict.DuplicateOf + "; the space reviews every reinforce, so its sources were not added"
		}
		return "a duplicate of " + verdict.DuplicateOf + ": its sources were added there"
	case "conflict":
		return "nothing applied: its entry moved, or passed into the owner's hands, since it was proposed"
	}
	return status
}

// ── The clean Claude Code ───────────────────────────────────────────────────────────────────────

// wikiVerifyClaudePath is the Claude Code to verify with: the very binary this session runs on
// (CLAUDE_CODE_EXECPATH), or the machine's own on the runner's engine path.
func wikiVerifyClaudePath() (string, error) {
	if wikiVerifyClaudeBinary != "" {
		return wikiVerifyClaudeBinary, nil
	}
	if exe := strings.TrimSpace(os.Getenv("CLAUDE_CODE_EXECPATH")); exe != "" {
		if info, err := os.Stat(exe); err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
			return exe, nil
		}
	}
	if exe, ok := lookPathIn(providerClaude, runnerEnginePath(userHome(), os.Getenv("PATH"))); ok {
		return exe, nil
	}
	return "", fmt.Errorf("orbit wiki verify runs a clean Claude Code, and there is no claude binary on this machine's " +
		"engine path: install Claude Code, or run it in a session that runs on one")
}

// wikiVerifyEndpointUp waits for nothing and asks once: the local model sits behind a tunnel that
// drops, and a run started against a dead one would count every op as a failure. vLLM answers
// /health 200 once it serves; an endpoint that has no /health (404) is not one to judge by it.
func wikiVerifyEndpointUp(baseURL string) error {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(baseURL + "/health")
	if err != nil {
		return fmt.Errorf("the model endpoint %s is not reachable (%v): nothing was verified — if it is the local model's "+
			"tunnel, wait for it to come back and run this again", baseURL, err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("the model endpoint %s is not ready (/health answered %d): nothing was verified — run this "+
			"again once it is", baseURL, resp.StatusCode)
	}
	return nil
}

// askWikiVerifier runs one clean Claude Code over prompt and returns the model's answer text, and what
// the call cost.
func askWikiVerifier(ctx context.Context, claude string, cfg wikiVerifyConfig, prompt string) (string, wikiModelUsage, error) {
	var usage wikiModelUsage
	scratch, err := os.MkdirTemp("", "orbit-wiki-verify-")
	if err != nil {
		return "", usage, err
	}
	defer os.RemoveAll(scratch)
	home := filepath.Join(scratch, "home")
	config := filepath.Join(scratch, "config")
	for _, dir := range []string{home, config} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return "", usage, err
		}
		// Onboarding done, and nothing else: the dirs are empty so no login, memory or setting of this
		// machine's reaches the call.
		if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(`{"hasCompletedOnboarding":true}`), 0o600); err != nil {
			return "", usage, err
		}
	}
	settings := filepath.Join(scratch, "settings.json")
	if err := os.WriteFile(settings, []byte(`{"apiKeyHelper":"printenv ANTHROPIC_AUTH_TOKEN"}`), 0o600); err != nil {
		return "", usage, err
	}
	cmd := exec.CommandContext(ctx, claude, wikiVerifyClaudeArgs(cfg.model, settings)...)
	cmd.Dir = scratch
	cmd.Env = wikiVerifyEnv(home, config, cfg)
	cmd.Stdin = strings.NewReader(prompt)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	var result struct {
		IsError        bool   `json:"is_error"`
		Result         string `json:"result"`
		APIErrorStatus *int   `json:"api_error_status"`
		Usage          struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(lastJSONLine(stdout.Bytes()), &result); err != nil {
		if ctx.Err() != nil {
			return "", usage, fmt.Errorf("Claude Code gave no answer within %s", wikiVerifyCallTimeout)
		}
		return "", usage, fmt.Errorf("Claude Code gave no result (%v): %s", runErr, lastLines(stderr.String(), 3))
	}
	usage.InputTokens = result.Usage.InputTokens + result.Usage.CacheReadInputTokens + result.Usage.CacheCreationInputTokens
	usage.OutputTokens = result.Usage.OutputTokens
	if (result.APIErrorStatus != nil && *result.APIErrorStatus == http.StatusUnauthorized) || (result.IsError && wikiVerify401.MatchString(result.Result)) {
		return "", usage, &wikiVerifyAuthError{detail: result.Result}
	}
	if result.IsError {
		return "", usage, fmt.Errorf("Claude Code reported an error: %s", result.Result)
	}
	return result.Result, usage, nil
}

var wikiVerify401 = regexp.MustCompile(`(?i)\b401\b|authentication_error|invalid api key`)

// wikiVerifyClaudeArgs is the clean launch (contract `agentSurface.verify.cleanClaudeCode`): print
// mode, no tools, no MCP server at all, no session file, the verifier's own short system prompt,
// and settings that name nothing but the apiKeyHelper. The prompt arrives on stdin.
func wikiVerifyClaudeArgs(model, settings string) []string {
	return []string{
		"-p",
		"--bare",
		"--tools", "",
		"--strict-mcp-config",
		"--mcp-config", `{"mcpServers":{}}`,
		"--no-session-persistence",
		"--output-format", "json",
		"--model", model,
		"--system-prompt", wikiVerifySystemPrompt,
		"--settings", settings,
	}
}

// wikiVerifyEnv is the clean call's whole environment, built from an allowlist (wikiVerifyEnvPass).
//
// THINKING IS OFF UNLESS ASKED FOR (contract `agentSurface.verify.thinking`). Claude Code sends a
// custom endpoint's model it does not know output_config.effort "high" and thinking {type: adaptive}
// of its own accord, and on the local model that is a verdict of a minute and some thousand tokens
// of reasoning where one without takes two seconds. CLAUDE_CODE_EFFORT_LEVEL=unset takes the effort
// out of the request, and MAX_THINKING_TOKENS=0 the thinking block with it; --effort puts an effort
// back, and thinking with it.
func wikiVerifyEnv(home, config string, cfg wikiVerifyConfig) []string {
	env := []string{
		"HOME=" + home,
		"CLAUDE_CONFIG_DIR=" + config,
		"ANTHROPIC_BASE_URL=" + cfg.baseURL,
		"ANTHROPIC_AUTH_TOKEN=" + cfg.token,
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
		"DISABLE_AUTOUPDATER=1",
	}
	if cfg.effort != "" {
		env = append(env, "CLAUDE_CODE_EFFORT_LEVEL="+cfg.effort)
	} else {
		env = append(env, "CLAUDE_CODE_EFFORT_LEVEL=unset", "MAX_THINKING_TOKENS=0")
	}
	for _, key := range wikiVerifyEnvPass {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}

// lastJSONLine is the last line of a Claude Code's stdout that is a JSON object: the result, in
// --output-format json, whatever it printed before it.
func lastJSONLine(out []byte) []byte {
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if strings.HasPrefix(line, "{") {
			return []byte(line)
		}
	}
	return nil
}

func lastLines(text string, n int) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}

// ── The prompt, and what may come back ──────────────────────────────────────────────────────────

// wikiVerifyCandidate is an entry a duplicate verdict may name: a live neighbour of the op, or an
// amend's own entry.
type wikiVerifyCandidate struct {
	ID, Kind, Title, Note string
}

func wikiVerifyCandidates(item wikiVerificationItem) []wikiVerifyCandidate {
	out := []wikiVerifyCandidate{}
	if item.Op == "amend" && item.EntryID != "" {
		out = append(out, wikiVerifyCandidate{ID: item.EntryID, Kind: item.Entry.Kind, Title: item.Entry.Title, Note: "the entry this amend changes"})
	}
	for _, near := range item.Similar {
		if near.Status != "active" || near.ID == item.EntryID {
			continue
		}
		out = append(out, wikiVerifyCandidate{ID: near.ID, Kind: near.Kind, Title: near.Title})
	}
	return out
}

// wikiVerifyPrompt is the one op, written for a model that sees nothing else: the entry as it would
// read, each record it cites, the entries it may repeat, and the one answer it may give.
func wikiVerifyPrompt(item wikiVerificationItem, candidates []wikiVerifyCandidate) string {
	var b strings.Builder
	b.WriteString("Check one proposed wiki entry against the records it cites.\n\n")
	if item.Op == "amend" {
		fmt.Fprintf(&b, "## The entry, as this change would leave it (a %s; the change amends entry %s)\n", item.Entry.Kind, item.EntryID)
	} else {
		fmt.Fprintf(&b, "## The entry (a %s)\n", item.Entry.Kind)
	}
	fmt.Fprintf(&b, "Title: %s\nSummary: %s\n", item.Entry.Title, item.Entry.Summary)
	if fields, err := json.MarshalIndent(item.Entry.Fields, "", "  "); err == nil && len(item.Entry.Fields) > 0 {
		fmt.Fprintf(&b, "Fields:\n%s\n", fields)
	}
	b.WriteString("\n## The records it cites\n")
	if len(item.Sources) == 0 {
		b.WriteString("None.\n")
	}
	for i, source := range item.Sources {
		fmt.Fprintf(&b, "\n### Record %d: %s %s\n", i+1, source.Kind, source.Ref)
		if source.Quote != nil && strings.TrimSpace(*source.Quote) != "" {
			fmt.Fprintf(&b, "The proposer quoted: %q\n", *source.Quote)
		}
		if source.Text == nil {
			b.WriteString("(This record's text is not available: judge by the quote alone, if there is one.)\n")
			continue
		}
		fmt.Fprintf(&b, "Text:\n%s\n", *source.Text)
		if source.Truncated {
			b.WriteString("(The text was cut here.)\n")
		}
	}
	b.WriteString("\n## Entries the space already holds that it may repeat\n")
	if len(candidates) == 0 {
		b.WriteString("None.\n")
	}
	for _, candidate := range candidates {
		note := ""
		if candidate.Note != "" {
			note = " (" + candidate.Note + ")"
		}
		fmt.Fprintf(&b, "- id %s: [%s] %s%s\n", candidate.ID, candidate.Kind, candidate.Title, note)
	}
	b.WriteString("\n## Your answer\n" +
		"Decide from the records alone:\n" +
		"- \"supported\": the records bear out everything the entry says.\n" +
		"- \"partial\": the records bear out some of it, and some of what it says is not in them.\n" +
		"- \"unsupported\": the records do not bear it out.\n" +
		"- \"duplicate\": it says what one of the entries listed above already says; give that entry's id as duplicateOf.\n" +
		"Answer with one JSON object and nothing else:\n" +
		`{"verdict": "supported" | "partial" | "unsupported" | "duplicate", "reason": "<one sentence>", "duplicateOf": "<the id, only for a duplicate>"}` + "\n")
	return b.String()
}

// wikiVerdict is one verdict as the model gave it, checked.
type wikiVerdict struct {
	Verdict     string
	Reason      string
	DuplicateOf string
}

// parseWikiVerdict reads the model's answer, and refuses anything that is not exactly a verdict:
// no JSON object, another verdict, no reason, or a duplicate that names no listed entry. What it
// refuses is reported as nothing — the op keeps waiting — because an answer read generously is how
// a verifier ends up letting through what it never said was supported.
func parseWikiVerdict(text string, candidates []wikiVerifyCandidate) (wikiVerdict, error) {
	body, ok := lastJSONObject(text)
	if !ok {
		return wikiVerdict{}, errors.New("no JSON object in it")
	}
	var raw struct {
		Verdict     *string `json:"verdict"`
		Reason      *string `json:"reason"`
		DuplicateOf *string `json:"duplicateOf"`
	}
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		return wikiVerdict{}, fmt.Errorf("its JSON does not read as a verdict: %v", err)
	}
	if raw.Verdict == nil || !contains(wikiVerifyVerdicts, strings.TrimSpace(*raw.Verdict)) {
		return wikiVerdict{}, fmt.Errorf("verdict is not one of %s", strings.Join(wikiVerifyVerdicts, ", "))
	}
	verdict := wikiVerdict{Verdict: strings.TrimSpace(*raw.Verdict)}
	if raw.Reason == nil || strings.TrimSpace(*raw.Reason) == "" {
		return wikiVerdict{}, errors.New("it gives no reason")
	}
	verdict.Reason = cutRunes(strings.TrimSpace(*raw.Reason), wikiVerifyReasonMaxChars)
	named := ""
	if raw.DuplicateOf != nil {
		named = strings.TrimSpace(*raw.DuplicateOf)
	}
	if verdict.Verdict == "duplicate" {
		for _, candidate := range candidates {
			if candidate.ID == named {
				verdict.DuplicateOf = named
				return verdict, nil
			}
		}
		return wikiVerdict{}, fmt.Errorf("a duplicate must name one of the listed entries, and %q is not one", named)
	}
	if named != "" {
		return wikiVerdict{}, fmt.Errorf("a %s verdict names a duplicate (%q), which only a duplicate does", verdict.Verdict, named)
	}
	return verdict, nil
}

// lastJSONObject is the last complete JSON object in text: a model that thinks aloud before it
// answers still answers last, and one wrapped in a ```json fence is still one object.
func lastJSONObject(text string) (string, bool) {
	for end := strings.LastIndex(text, "}"); end >= 0; end = strings.LastIndex(text[:end], "}") {
		for start := strings.LastIndex(text[:end], "{"); start >= 0; start = strings.LastIndex(text[:start], "{") {
			var probe map[string]json.RawMessage
			if json.Unmarshal([]byte(text[start:end+1]), &probe) == nil {
				if _, has := probe["verdict"]; has {
					return text[start : end+1], true
				}
			}
		}
	}
	return "", false
}

func cutRunes(text string, max int) string {
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return string(runes[:max])
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────

func cliWikiVerify(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki verify")
	space := fs.String("space", "", "the automatic space this session proposed into")
	model := fs.String("model", "", "the model to verify with")
	effort := fs.String("effort", "", "think with this effort; the model does not think without it")
	max := fs.Int("max", 0, "verify at most this many ops")
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
	if *max < 0 {
		return fmt.Errorf("--max must be a whole number, 1 or more")
	}
	level := strings.TrimSpace(*effort)
	if level != "" && !slices.Contains(wikiVerifyEfforts, level) {
		return fmt.Errorf("--effort must be one of %s; leave it out and the model does not think", strings.Join(wikiVerifyEfforts, ", "))
	}
	cfg, err := wikiVerifyConfigFromEnv(*model)
	if err != nil {
		return err
	}
	cfg.effort = level
	t, err := cliTransport()
	if err != nil {
		return err
	}
	progress := out
	if *jsonOut {
		progress = io.Discard
	}
	summary, runErr := runWikiVerify(t, ctx.sessionID, spaceID, cfg, *max, progress)
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
	if summary.Stopped != "" {
		return fmt.Errorf("stopped: %s", summary.Stopped)
	}
	return nil
}

func describeWikiVerifySummary(s wikiVerifySummary) string {
	if s.Looked == 0 && s.Stopped == "" {
		return fmt.Sprintf("Nothing this session proposed waits for its verification in space %s.", s.SpaceID)
	}
	line := fmt.Sprintf("Verified %d of %d with %s in space %s: %d supported, %d partial, %d unsupported, %d duplicate",
		s.Verified, s.Looked, s.Model, s.SpaceID, s.Supported, s.Partial, s.Unsupported, s.Duplicate)
	if s.Failed > 0 {
		line += fmt.Sprintf("; %d without a verdict", s.Failed)
	}
	line += "."
	if s.Stopped != "" {
		line += " Stopped: " + s.Stopped + "."
	}
	return line
}
