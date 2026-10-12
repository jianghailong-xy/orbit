package main

import (
	"os"
	"strings"
	"unicode/utf8"
)

// Claude Code's guess at what the person will type next (docs/prompt-suggestions-design.md).
//
// With `--prompt-suggestions` the CLI follows each turn's `result` with one more frame, about a
// second later:
//
//	{"type":"prompt_suggestion","suggestion":"run the tests","uuid":"…","session_id":"…"}
//
// It forks one request off the finished conversation for it (same model, cached prefix, no
// tools), and stays silent when the next step is not obvious, when the turn failed, in plan mode,
// and on the conversation's first turn. A message that arrives while it is generating cancels it.
// Orbit files what it says as a prompt_suggestion event against the turn it follows; the clients
// offer it in the empty composer and never draw it as a transcript row.

// claudePromptSuggestionFrame is the stream-json type the CLI writes the suggestion as.
const claudePromptSuggestionFrame = "prompt_suggestion"

// claudePromptSuggestionsFloor is the oldest `claude` Orbit passes --prompt-suggestions to. It is
// the version the frame above was measured on (2026-10-08), not where support began: an older CLI
// that does not know the flag refuses to start at all, so the floor errs high.
const claudePromptSuggestionsFloor = "2.1.293"

// maxPromptSuggestionRunes caps what is filed. The CLI keeps its own under 100 characters, so a
// longer one is not a suggestion and is dropped rather than cut.
const maxPromptSuggestionRunes = 200

// claudeSpawnVersion is the version of the `claude` the next spawn will run. A variable so the
// flag's gate can be tested without a real CLI on PATH.
var claudeSpawnVersion = claudeCLIVersion

// claudePromptSuggestionsOn reports whether this spawn asks for suggestions: the control plane
// turned them on for the session, the CLI is new enough to know the flag, and the engine talks
// to an endpoint the suggestion was measured on. The last check is the runner's own: the control
// plane already leaves out any other configured provider, but a provider switched in by a
// `reload` brings its endpoint with it, and the runner's own environment may point the CLI
// somewhere the control plane cannot see. The suggestion request is billed wherever the engine
// talks to.
func claudePromptSuggestionsOn(job *ClaimedSession) bool {
	return job.Agent.PromptSuggestions &&
		claudeTalksToMeasuredEndpoint(job.Agent.Env) &&
		claudeVersionAtLeast(claudeSpawnVersion(), claudePromptSuggestionsFloor)
}

// claudeSuggestionEndpoints are the endpoints the suggestion request was measured on
// (docs/prompt-suggestions-design.md §1.3): Anthropic's own, which an unset base URL means, and
// DeepSeek's Anthropic-compatible one.
var claudeSuggestionEndpoints = map[string]bool{
	"":                                   true,
	"https://api.anthropic.com":          true,
	"https://api.deepseek.com/anthropic": true,
}

// claudeTalksToMeasuredEndpoint reports whether a claude spawned with agentEnv layered over this
// process's environment (envWithAgent) talks to one of claudeSuggestionEndpoints.
func claudeTalksToMeasuredEndpoint(agentEnv map[string]string) bool {
	base, set := agentEnv["ANTHROPIC_BASE_URL"]
	if !set {
		base = os.Getenv("ANTHROPIC_BASE_URL")
	}
	return claudeSuggestionEndpoints[strings.TrimRight(strings.TrimSpace(base), "/")]
}

// promptSuggestionPayload is the event a prompt_suggestion frame becomes, or nil when it carries
// nothing worth offering.
func promptSuggestionPayload(msg map[string]interface{}) map[string]interface{} {
	text, _ := msg["suggestion"].(string)
	text = strings.TrimSpace(text)
	if text == "" || utf8.RuneCountInString(text) > maxPromptSuggestionRunes {
		return nil
	}
	return map[string]interface{}{"text": text, "source": "engine"}
}
