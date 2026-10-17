package main

import (
	"bufio"
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
	"strconv"
	"strings"
	"time"
)

// The drafting job's model calls (contracts/wiki.contract.json `plan.jobs.run.model`): one clean Claude
// Code a unit of the plan — wiki_verify.go's launch, flag for flag (--bare, no tools, no MCP server at
// all, no session file, the apiKeyHelper that sends the provider's token as a Bearer), with
// `--setting-sources ''` besides, an empty HOME and CLAUDE_CONFIG_DIR of its own, and thinking off.
//
// THE ANSWER STREAMS TO DISK AS IT ARRIVES. The sample's first catalogue was one call that ran into its
// hour-long timeout and left nothing: an hour of the GPU for no line of the plan. So every call is small
// — one step of one unit — and its answer is written, event by event (`--output-format stream-json
// --include-partial-messages`), into a file of the run's work directory while the model is still
// writing it: whoever looks can see how far it got, and a call cut short leaves what it had.
//
// THE ENDPOINT IS WAITED FOR, AND A 401 STOPS EVERYTHING. The local model sits behind a tunnel that
// drops: before each call the run waits for its /health to answer 200 (wikiPlanHealthWait at most). A
// 401 means every later call would be refused the same way — and a real Claude Code retries each for
// three minutes — so the first one ends the run.

// wikiPlanSystemPrompt is the whole system prompt every drafting call carries: what the model is for.
const wikiPlanSystemPrompt = "You are the chief editor of this repository's documentation. You plan its product and technical documents from the " +
	"materials you are given. Use only the file paths, section headings, symbols and project names that appear in the materials, " +
	"and invent none. Write in English; keep code names, paths and commands as they are. Output only what is asked for."

// wikiPlanMaxOutputTokens is what one call may write: a catalogue of forty documents is some fifteen
// thousand tokens in the compact line format, and Claude Code's own default for a model it does not know
// is lower than that.
const wikiPlanMaxOutputTokens = 32000

var (
	// One call from the local model: the sample's longest (a catalogue skeleton) took thirteen minutes,
	// three times that when the GPU is shared.
	wikiPlanCallTimeout = 60 * time.Minute
	// How long a call waits for the endpoint's /health before it gives up, and how often it asks.
	wikiPlanHealthWait = 20 * time.Minute
	wikiPlanHealthPoll = 10 * time.Second
)

// wikiPlanAuthError is the endpoint refusing the token: the run stops at it.
type wikiPlanAuthError struct{ detail string }

func (e *wikiPlanAuthError) Error() string {
	return "the model endpoint refused the token (401): check the ANTHROPIC_AUTH_TOKEN this session's provider " +
		"injected; nothing more was asked. " + e.detail
}

// wikiPlanClaudeArgs is the verifier's clean launch with the drafting job's system prompt, the answer
// streamed, and no settings source read at all — a workspace's .claude/settings.json is read even under
// --bare, and its env block outranks the provider's.
func wikiPlanClaudeArgs(model, settings string) []string {
	args := wikiArticleClaudeArgs(model, settings, wikiPlanSystemPrompt)
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--output-format" {
			args[i+1] = "stream-json"
		}
	}
	return append(args, "--verbose", "--include-partial-messages", "--setting-sources", "")
}

// wikiPlanEnv is the verifier's allowlisted environment with thinking off (wikiArticleEnv), and room for
// a whole catalogue in one answer.
func wikiPlanEnv(home, config string, cfg wikiVerifyConfig) []string {
	return append(wikiArticleEnv(home, config, cfg), "CLAUDE_CODE_MAX_OUTPUT_TOKENS="+strconv.Itoa(wikiPlanMaxOutputTokens))
}

// wikiPlanCall is one call's record: the unit, what it cost and how long it took, whether it answered.
type wikiPlanCall struct {
	Step    string  `json:"step"`
	Unit    string  `json:"unit"`
	Attempt int     `json:"attempt"`
	Input   int     `json:"input"`
	Output  int     `json:"output"`
	Seconds float64 `json:"seconds"`
	OK      bool    `json:"ok"`
	Error   string  `json:"error,omitempty"`
	Stream  string  `json:"stream"`
}

// askWikiPlanModel runs one clean Claude Code over prompt, its answer streaming into streamPath (and its
// stderr beside it), and returns the answer and what it cost.
func askWikiPlanModel(ctx context.Context, claude string, cfg wikiVerifyConfig, prompt, streamPath string) (string, wikiModelUsage, error) {
	var usage wikiModelUsage
	scratch, err := os.MkdirTemp("", "orbit-wiki-plan-")
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
		// Onboarding done, and nothing else: no login, memory or setting of this machine reaches the call.
		if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(`{"hasCompletedOnboarding":true}`), 0o600); err != nil {
			return "", usage, err
		}
	}
	settings := filepath.Join(scratch, "settings.json")
	if err := os.WriteFile(settings, []byte(`{"apiKeyHelper":"printenv ANTHROPIC_AUTH_TOKEN"}`), 0o600); err != nil {
		return "", usage, err
	}
	if err := os.MkdirAll(filepath.Dir(streamPath), 0o755); err != nil {
		return "", usage, err
	}
	stream, err := os.Create(streamPath)
	if err != nil {
		return "", usage, err
	}
	defer stream.Close()
	errFile, err := os.Create(streamPath + ".err")
	if err != nil {
		return "", usage, err
	}
	defer errFile.Close()
	cmd := exec.CommandContext(ctx, claude, wikiPlanClaudeArgs(cfg.model, settings)...)
	cmd.Dir = scratch
	cmd.Env = wikiPlanEnv(home, config, cfg)
	cmd.Stdin = strings.NewReader(prompt)
	cmd.Stdout = stream
	cmd.Stderr = errFile
	runErr := cmd.Run()
	_ = stream.Sync()
	raw, _ := os.ReadFile(streamPath)
	text, usage, err := readWikiPlanStream(raw)
	if err != nil {
		var auth *wikiPlanAuthError
		if errors.As(err, &auth) {
			return "", usage, err
		}
		if ctx.Err() != nil {
			return "", usage, fmt.Errorf("Claude Code gave no answer within %s (%d characters had arrived; they are in %s)",
				wikiPlanCallTimeout, len([]rune(wikiPlanStreamedText(raw))), streamPath)
		}
		stderr, _ := os.ReadFile(streamPath + ".err")
		return "", usage, fmt.Errorf("%v (%v): %s", err, runErr, lastLines(string(stderr), 3))
	}
	return text, usage, nil
}

// readWikiPlanStream reads a stream-json answer: the result line's text and usage, and a 401 as the
// error that ends the run.
func readWikiPlanStream(raw []byte) (string, wikiModelUsage, error) {
	var usage wikiModelUsage
	var result struct {
		Type           string `json:"type"`
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
	found := false
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 1<<20), 1<<26)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 || line[0] != '{' || !bytes.Contains(line, []byte(`"result"`)) {
			continue
		}
		var probe struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(line, &probe) != nil || probe.Type != "result" {
			continue
		}
		if json.Unmarshal(line, &result) == nil {
			found = true
		}
	}
	if !found {
		return "", usage, errors.New("Claude Code gave no result")
	}
	usage.InputTokens = result.Usage.InputTokens + result.Usage.CacheReadInputTokens + result.Usage.CacheCreationInputTokens
	usage.OutputTokens = result.Usage.OutputTokens
	if (result.APIErrorStatus != nil && *result.APIErrorStatus == http.StatusUnauthorized) || (result.IsError && wikiVerify401.MatchString(result.Result)) {
		return "", usage, &wikiPlanAuthError{detail: result.Result}
	}
	if result.IsError {
		return "", usage, fmt.Errorf("Claude Code reported an error: %s", result.Result)
	}
	return result.Result, usage, nil
}

// wikiPlanStreamedText is what text deltas a stream carried so far: what a call cut short had written.
func wikiPlanStreamedText(raw []byte) string {
	var b strings.Builder
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 1<<20), 1<<26)
	for scanner.Scan() {
		var event struct {
			Type  string `json:"type"`
			Event struct {
				Type  string `json:"type"`
				Delta struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"delta"`
			} `json:"event"`
		}
		if json.Unmarshal(scanner.Bytes(), &event) != nil || event.Type != "stream_event" {
			continue
		}
		if event.Event.Type == "content_block_delta" && event.Event.Delta.Type == "text_delta" {
			b.WriteString(event.Event.Delta.Text)
		}
	}
	return b.String()
}

// wikiPlanWaitForEndpoint waits for the endpoint's /health to answer 200 (or 404, an endpoint that has
// no health route), for wikiPlanHealthWait at most.
func wikiPlanWaitForEndpoint(baseURL string, progress io.Writer) error {
	deadline := time.Now().Add(wikiPlanHealthWait)
	said := false
	for {
		err := wikiVerifyEndpointUp(baseURL)
		if err == nil {
			return nil
		}
		if !time.Now().Add(wikiPlanHealthPoll).Before(deadline) {
			return fmt.Errorf("the model endpoint did not answer /health within %s: %v", wikiPlanHealthWait, err)
		}
		if !said {
			fmt.Fprintf(progress, "The model endpoint is not up (%v); waiting for it.\n", err)
			said = true
		}
		time.Sleep(wikiPlanHealthPoll)
	}
}
