package main

// Wire DTOs — JSON tags mirror @orbit/shared exactly (camelCase). The control
// plane's ValidationPipe passes these plain objects through unchanged.

type DeviceStartRequest struct {
	Name          string   `json:"name"` // the runner (machine) name; defaults to the hostname
	Hostname      string   `json:"hostname,omitempty"`
	Labels        []string `json:"labels"`
	MaxConcurrent int      `json:"maxConcurrent"`
	Version       string   `json:"version,omitempty"`
	// Default project directory; agents (registered separately) run claude here.
	WorkDir string `json:"workDir,omitempty"`
}

type DeviceStartResponse struct {
	DeviceCode string `json:"deviceCode"`
	UserCode   string `json:"userCode"`
	Interval   int    `json:"interval"`
	ExpiresIn  int    `json:"expiresIn"`
}

type DevicePollResponse struct {
	Status      string `json:"status"`
	RunnerID    string `json:"runnerId"`
	RunnerToken string `json:"runnerToken"`
	Name        string `json:"name"` // the runner (machine) name
}

type RegisterRequest struct {
	EnrollmentToken string   `json:"enrollmentToken"`
	Name            string   `json:"name"` // the runner (machine) name; defaults to the hostname
	Hostname        string   `json:"hostname,omitempty"`
	Labels          []string `json:"labels"`
	MaxConcurrent   int      `json:"maxConcurrent"`
	Version         string   `json:"version,omitempty"`
	// Default project directory; agents (registered separately) run claude here.
	WorkDir string `json:"workDir,omitempty"`
}

type RegisterResponse struct {
	RunnerID    string `json:"runnerId"`
	RunnerToken string `json:"runnerToken"`
	Name        string `json:"name"` // the runner (machine) name
}

type HeartbeatRequest struct {
	Status       string `json:"status"`
	IdleCapacity int    `json:"idleCapacity"`
	Version      string `json:"version,omitempty"`
}

type HeartbeatResponse struct {
	CancelSessionIDs []string `json:"cancelSessionIds"`
}

type MeResponse struct {
	ID              string        `json:"id"`
	Name            string        `json:"name"`
	Status          string        `json:"status"`
	Online          bool          `json:"online"`
	LastHeartbeatAt *string       `json:"lastHeartbeatAt"`
	Version         *string       `json:"version"`
	Labels          []string      `json:"labels"`
	MaxConcurrent   int           `json:"maxConcurrent"`
	Agents          []RunnerAgent `json:"agents"`
}

// RunnerAgent is one agent registered under this machine's runner, as reported by
// `GET /runner/me` and shown by `orbit status`.
type RunnerAgent struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	AgentKey string `json:"agentKey,omitempty"`
	WorkDir  string `json:"workDir,omitempty"`
}

type AgentExecConfig struct {
	Model              string                 `json:"model"`
	AppendSystemPrompt string                 `json:"appendSystemPrompt"`
	SystemPrompt       string                 `json:"systemPrompt"`
	AllowedTools       []string               `json:"allowedTools"`
	DisallowedTools    []string               `json:"disallowedTools"`
	PermissionMode     string                 `json:"permissionMode"`
	Effort             string                 `json:"effort"`
	MaxTurns           *int                   `json:"maxTurns"`
	MaxBudgetUsd       *float64               `json:"maxBudgetUsd"`
	McpConfig          map[string]interface{} `json:"mcpConfig"`
}

// ClaimedSession is one interactive session a runner has claimed (or reclaimed).
type ClaimedSession struct {
	SessionID string          `json:"sessionId"`
	Title     string          `json:"title"`
	Prompt    string          `json:"prompt"`
	Agent     AgentExecConfig `json:"agent"`
	// WorkDir is claude's cwd for this session, from the session's agent.
	WorkDir     string `json:"workDir,omitempty"`
	SessionUUID string `json:"sessionUuid"`
	MaxSeq      int    `json:"maxSeq"`
	// Resume marks a session revived from an ended state: like a reclaim, claude's
	// session already exists, so even the first spawn must --resume. Server-set.
	Resume bool `json:"resume"`
	// Reclaimed marks a session re-attached after a runner restart: the claude
	// session already exists, so the first spawn must --resume, not --session-id.
	// Runner-internal (never sent by the server).
	Reclaimed bool `json:"-"`
}

// Interactive sessions (Route B) — wire DTOs mirroring @orbit/shared.

// RunInboxResponse is the next user turn to feed the live claude process.
// TurnID == "" means nothing is available (mirrors the empty-runId claim convention).
type RunInboxResponse struct {
	TurnID  string `json:"turnId"`
	Seq     int    `json:"seq"`
	Kind    string `json:"kind"`
	Content string `json:"content,omitempty"`
}

type ReclaimSession struct {
	SessionID   string          `json:"sessionId"`
	Title       string          `json:"title"`
	SessionUUID string          `json:"sessionUuid"`
	MaxSeq      int             `json:"maxSeq"`
	Agent       AgentExecConfig `json:"agent"`
	// WorkDir is claude's cwd for this session, from the session's agent.
	WorkDir string `json:"workDir,omitempty"`
}

type ReclaimResponse struct {
	Sessions []ReclaimSession `json:"sessions"`
}

type TurnCompleteRequest struct {
	TurnID     string                 `json:"turnId"`
	Status     string                 `json:"status"`
	Result     string                 `json:"result,omitempty"`
	Subtype    string                 `json:"subtype,omitempty"`
	NumTurns   int                    `json:"numTurns"`
	CostUsd    float64                `json:"costUsd"`
	Usage      *TokenUsage            `json:"usage,omitempty"`
	ModelUsage map[string]interface{} `json:"modelUsage,omitempty"`
}

type RunEvent struct {
	Seq     int                    `json:"seq"`
	Type    string                 `json:"type"`
	TS      string                 `json:"ts"`
	TurnID  string                 `json:"turnId,omitempty"`
	Payload map[string]interface{} `json:"payload"`
}

type RunEventBatch struct {
	Events []RunEvent `json:"events"`
}

type TokenUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
}

type CompleteRequest struct {
	Status          string                 `json:"status"`
	Result          string                 `json:"result,omitempty"`
	Subtype         string                 `json:"subtype,omitempty"`
	Error           string                 `json:"error,omitempty"`
	ClaudeSessionID string                 `json:"claudeSessionId,omitempty"`
	NumTurns        int                    `json:"numTurns"`
	DurationMs      int                    `json:"durationMs"`
	CostUsd         float64                `json:"costUsd"`
	Usage           *TokenUsage            `json:"usage,omitempty"`
	ModelUsage      map[string]interface{} `json:"modelUsage,omitempty"`
}

type Manifest struct {
	Version string `json:"version"`
}

// Run-event type strings — mirror RunEventType in @orbit/shared.
const (
	evSystem        = "system"
	evAssistant     = "assistant"
	evTextDelta     = "text_delta"
	evThinking      = "thinking"
	evThinkingDelta = "thinking_delta"
	evToolUse       = "tool_use"
	evToolResult    = "tool_result"
	evError         = "error"
	// Interactive sessions (Route B)
	evUser      = "user"
	evTurnEnd   = "turn_end"
	evInterrupt = "interrupt"
)

// Run statuses — mirror RunStatus in @orbit/shared.
const (
	stSucceeded     = "SUCCEEDED"
	stFailed        = "FAILED"
	stCancelled     = "CANCELLED"
	stAwaitingInput = "AWAITING_INPUT"
	stInterrupted   = "INTERRUPTED"
)
