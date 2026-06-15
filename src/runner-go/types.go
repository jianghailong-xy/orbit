package main

// Wire DTOs — JSON tags mirror @orbit/shared exactly (camelCase). The control
// plane's ValidationPipe passes these plain objects through unchanged.

type DeviceStartRequest struct {
	Name          string   `json:"name"`
	Hostname      string   `json:"hostname,omitempty"`
	Labels        []string `json:"labels"`
	MaxConcurrent int      `json:"maxConcurrent"`
	Version       string   `json:"version,omitempty"`
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
	Name        string `json:"name"`
}

type RegisterRequest struct {
	EnrollmentToken string   `json:"enrollmentToken"`
	Name            string   `json:"name"`
	Hostname        string   `json:"hostname,omitempty"`
	Labels          []string `json:"labels"`
	MaxConcurrent   int      `json:"maxConcurrent"`
	Version         string   `json:"version,omitempty"`
}

type RegisterResponse struct {
	RunnerID    string `json:"runnerId"`
	RunnerToken string `json:"runnerToken"`
	Name        string `json:"name"`
}

type HeartbeatRequest struct {
	Status       string `json:"status"`
	IdleCapacity int    `json:"idleCapacity"`
	Version      string `json:"version,omitempty"`
}

type HeartbeatResponse struct {
	CancelRunIDs []string `json:"cancelRunIds"`
}

type MeResponse struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Status          string   `json:"status"`
	Online          bool     `json:"online"`
	LastHeartbeatAt *string  `json:"lastHeartbeatAt"`
	Version         *string  `json:"version"`
	Labels          []string `json:"labels"`
	MaxConcurrent   int      `json:"maxConcurrent"`
}

type AgentExecConfig struct {
	Model              string                 `json:"model"`
	AppendSystemPrompt string                 `json:"appendSystemPrompt"`
	SystemPrompt       string                 `json:"systemPrompt"`
	AllowedTools       []string               `json:"allowedTools"`
	DisallowedTools    []string               `json:"disallowedTools"`
	PermissionMode     string                 `json:"permissionMode"`
	MaxTurns           *int                   `json:"maxTurns"`
	MaxBudgetUsd       *float64               `json:"maxBudgetUsd"`
	McpConfig          map[string]interface{} `json:"mcpConfig"`
}

type ClaimedJob struct {
	RunID           string                 `json:"runId"`
	TaskID          string                 `json:"taskId"`
	Title           string                 `json:"title"`
	Input           map[string]interface{} `json:"input"`
	Prompt          string                 `json:"prompt"`
	Agent           AgentExecConfig        `json:"agent"`
	ResumeSessionID string                 `json:"resumeSessionId"`
}

type RunEvent struct {
	Seq     int                    `json:"seq"`
	Type    string                 `json:"type"`
	TS      string                 `json:"ts"`
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
	evSystem     = "system"
	evAssistant  = "assistant"
	evTextDelta  = "text_delta"
	evToolUse    = "tool_use"
	evToolResult = "tool_result"
	evError      = "error"
)

// Run statuses — mirror RunStatus in @orbit/shared.
const (
	stSucceeded = "SUCCEEDED"
	stFailed    = "FAILED"
	stCancelled = "CANCELLED"
)
