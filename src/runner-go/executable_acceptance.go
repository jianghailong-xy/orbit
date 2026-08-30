package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	executableAcceptanceSchemaRevision     = 2
	executableAcceptanceCapabilityRevision = 2
	// This is a process hard maximum, not a default. It intentionally admits the repository's
	// 1200-second watchdog plan while remaining below the server's one-day validation maximum.
	executableAcceptanceHardMaxSeconds = 3600
	executableAcceptanceOutputMaxBytes = 4 << 20
)

func executableAcceptanceRunnerSHA() string {
	identity := strings.TrimSpace(sourceSHA)
	if len(identity) < 7 {
		return "dev-local"
	}
	return identity
}

func executableAcceptanceCapabilityV2() *ExecutableAcceptanceCapability {
	return &ExecutableAcceptanceCapability{
		SchemaRevision:     executableAcceptanceSchemaRevision,
		CapabilityRevision: executableAcceptanceCapabilityRevision,
		HardMaxSeconds:     executableAcceptanceHardMaxSeconds,
		RunnerSha:          executableAcceptanceRunnerSHA(),
	}
}

func executableAcceptanceCapabilityHeaderValue() string {
	b, err := json.Marshal(executableAcceptanceCapabilityV2())
	if err != nil {
		panic(err) // fixed scalar struct: failure is a programmer error, never runtime input
	}
	return string(b)
}

func commandSHA256(command string) string {
	digest := sha256.Sum256([]byte(command))
	return hex.EncodeToString(digest[:])
}

func validateExecutableDispatchPlan(command string, plan *ExecutableAcceptanceDispatchPlan) error {
	if plan == nil {
		return errors.New("missing executable acceptance dispatch plan")
	}
	if plan.AdmissionID == "" || len(plan.EvaluationPlanDigest) != 64 || len(plan.CommandDigest) != 64 {
		return errors.New("executable acceptance dispatch is missing its admission/digest binding")
	}
	if commandSHA256(command) != plan.CommandDigest {
		return errors.New("executable acceptance command digest does not bind delivered command")
	}
	if plan.RequiredSchemaRevision != executableAcceptanceSchemaRevision ||
		plan.RequiredCapabilityRevision > executableAcceptanceCapabilityRevision {
		return fmt.Errorf("executable acceptance revision %d/%d is not supported by runner %d/%d",
			plan.RequiredSchemaRevision, plan.RequiredCapabilityRevision,
			executableAcceptanceSchemaRevision, executableAcceptanceCapabilityRevision)
	}
	if plan.RequestedTimeoutSeconds <= 0 ||
		plan.EffectiveTimeoutSeconds != plan.RequestedTimeoutSeconds {
		return errors.New("ADMITTED executable acceptance was silently clamped")
	}
	if plan.RequestedTimeoutSeconds > executableAcceptanceHardMaxSeconds {
		return fmt.Errorf("admitted timeout %ds exceeds runner hard max %ds",
			plan.RequestedTimeoutSeconds, executableAcceptanceHardMaxSeconds)
	}
	if _, err := time.Parse(time.RFC3339Nano, plan.EffectiveDeadline); err != nil {
		return fmt.Errorf("invalid executable acceptance effective deadline: %w", err)
	}
	return nil
}

func cappedExecutableOutput(out []byte) (string, bool) {
	if len(out) <= executableAcceptanceOutputMaxBytes {
		return string(out), false
	}
	return string(out[:executableAcceptanceOutputMaxBytes]), true
}

type executableOutputBuffer struct {
	buffer    bytes.Buffer
	truncated bool
}

func (b *executableOutputBuffer) Write(p []byte) (int, error) {
	written := len(p)
	remaining := executableAcceptanceOutputMaxBytes - b.buffer.Len()
	if remaining <= 0 {
		b.truncated = b.truncated || written > 0
		return written, nil
	}
	if len(p) > remaining {
		b.truncated = true
		p = p[:remaining]
	}
	_, _ = b.buffer.Write(p)
	return written, nil
}

func classifyExecutableAcceptanceTermination(
	ctx context.Context,
	commandCtx context.Context,
	processState *os.ProcessState,
) (string, *int, string) {
	// Wait can observe a completed leader before copied output or process-tree cleanup finishes.
	// Once that leader has a concrete exit code, a deadline or cancellation observed during the
	// remaining cleanup cannot rewrite the process fact. A signaled process has no such exit fact,
	// so its context still decides whether the runner timed it out or cancelled it.
	if processState != nil {
		exitCode := processState.ExitCode()
		if exitCode >= 0 {
			return "EXITED", &exitCode, ""
		}
	}

	switch {
	case errors.Is(commandCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil:
		return "TIMED_OUT", nil, ""
	case ctx.Err() != nil:
		return "CANCELLED", nil, ""
	case processState != nil:
		return "SIGNALED", nil, processState.String()
	default:
		return "INFRASTRUCTURE_LOST", nil, ""
	}
}

// runExecutableAcceptance crosses the persisted start boundary before cmd.Start and returns one
// typed process fact. Every termination is reported with turn status SUCCEEDED: the shell
// transport worked and the typed fact, not generic session failure, owns what happens next.
func runExecutableAcceptance(
	ctx context.Context,
	t *Transport,
	sessionID string,
	execDir string,
	command string,
	emit emitFn,
	turnID string,
	env map[string]string,
	plan *ExecutableAcceptanceDispatchPlan,
) (TurnCompleteRequest, error) {
	if err := validateExecutableDispatchPlan(command, plan); err != nil {
		return TurnCompleteRequest{}, err
	}
	started, err := t.startExecutableAcceptance(ctx, sessionID, plan.AdmissionID)
	if err != nil {
		return TurnCompleteRequest{}, err
	}
	deadline, err := time.Parse(time.RFC3339Nano, plan.EffectiveDeadline)
	if err != nil {
		return TurnCompleteRequest{}, err
	}
	startDeadline, err := time.Parse(time.RFC3339Nano, started.DeadlineAt)
	if err != nil || !startDeadline.Equal(deadline) {
		return TurnCompleteRequest{}, errors.New("attempt start deadline does not match admission")
	}

	toolUseID := "shell-" + turnID
	emit(evToolUse, map[string]interface{}{
		"id": toolUseID, "name": "Bash", "input": map[string]interface{}{"command": command},
	})

	termination := "INFRASTRUCTURE_LOST"
	var actualExit *int
	var signal string
	var output []byte
	var runErr error

	// A delayed start handshake can consume the entire admitted window. Record that deadline fact
	// without spawning a process after it; this is still a typed ADMITTED attempt, never a rejection.
	if !time.Now().Before(deadline) {
		termination = "TIMED_OUT"
		runErr = context.DeadlineExceeded
	} else {
		commandCtx, cancel := context.WithDeadline(ctx, deadline)
		defer cancel()
		cmd := exec.CommandContext(commandCtx, "bash", "-lc", command)
		configureSessionProcessTree(cmd)
		cmd.Dir = execDir
		cmd.Env = envWithAgent(env)
		var combined executableOutputBuffer
		cmd.Stdout = &combined
		cmd.Stderr = &combined
		if err := cmd.Start(); err != nil {
			termination = "START_FAILED"
			runErr = err
		} else {
			runErr = waitSessionProcessTree(cmd)
			termination, actualExit, signal = classifyExecutableAcceptanceTermination(
				ctx, commandCtx, cmd.ProcessState,
			)
		}
		output = combined.buffer.Bytes()
		if combined.truncated {
			output = append(output, []byte("\n[OUTPUT_TRUNCATED_AT_4_MIB]")...)
		}
	}
	if runErr != nil && termination != "EXITED" {
		output = append(output, []byte("\n["+termination+": "+runErr.Error()+"]")...)
	}
	rawOutput, truncated := cappedExecutableOutput(output)
	isError := termination != "EXITED" || actualExit == nil || *actualExit != plan.ExpectedExitCode
	emit(evToolResult, map[string]interface{}{
		"toolUseId": toolUseID, "content": rawOutput, "isError": isError,
	})
	return TurnCompleteRequest{
		TurnID:                    turnID,
		Status:                    stSucceeded,
		Result:                    termination,
		Subtype:                   "shell",
		ShellOutput:               &rawOutput,
		AcceptanceAdmissionID:     plan.AdmissionID,
		AcceptanceAttemptID:       started.AttemptID,
		AcceptanceTerminationKind: termination,
		AcceptanceActualExitCode:  actualExit,
		AcceptanceSignal:          signal,
		AcceptanceOutputTruncated: truncated,
	}, nil
}

// runSynchronousShellTurn is the rolling protocol switch. A legacy delivery retains its fixed
// two-minute sentinel behavior; a v2 delivery cannot fall back to it because doing so would erase
// the admission and typed-termination contract the task was bound to.
func runSynchronousShellTurn(
	ctx context.Context,
	t *Transport,
	job *ClaimedSession,
	execDir string,
	resp *RunInboxResponse,
	emit emitFn,
) (TurnCompleteRequest, error) {
	if resp.AcceptancePlan != nil {
		return runExecutableAcceptance(
			ctx, t, job.SessionID, execDir, resp.Content, emit, resp.TurnID, job.Agent.Env,
			resp.AcceptancePlan,
		)
	}
	out, exitCode := runShellTurn(
		ctx, execDir, resp.Content, emit, resp.TurnID, job.Agent.Env,
	)
	return TurnCompleteRequest{
		TurnID: resp.TurnID, Status: stSucceeded, Result: fmt.Sprintf("exit %d", exitCode),
		ShellExitCode: &exitCode, ShellOutput: &out, Subtype: "shell",
	}, nil
}
