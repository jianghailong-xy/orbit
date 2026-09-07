package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The door an agent's background job comes in through. `orbit mcp` is a child of
// the engine, so anything IT spawns dies with the engine — which is the bug. So
// the MCP server does not spawn: it asks the runner, over a unix socket in the
// session's own scratch dir, and the runner spawns and keeps the process.
//
// The socket is per session run and lives as long as the session, not the
// engine: an engine that restarts leaves its jobs running, and the agent finds
// them again through the same socket with the same ids.

const (
	bgSocketProtocolVersion = 1
	bgSocketRequestCap      = 64 * 1024
	bgSocketTimeout         = 30 * time.Second
	// A unix socket path is bounded by sun_path — 108 bytes on Linux, 104 on
	// macOS, and a bind that exceeds it fails with a message about nothing in
	// particular. Refuse early and say which path was too long.
	bgSocketPathCap = 100
)

// bgTransportUnavailable is the error code the agent-facing tools report when
// they cannot reach the runner. Deliberately not a fallback to the engine's own
// background shell: an agent that thinks it has a runner-hosted job and actually
// has an engine child is worse off than one told plainly that this did not work.
const bgTransportUnavailable = "BG_TRANSPORT_UNAVAILABLE"

func bgSocketPath(sessionID string) string { return filepath.Join(runDir(sessionID), "bg.sock") }
func bgTokenPath(sessionID string) string  { return filepath.Join(runDir(sessionID), "bg.token") }

type bgSocketRequest struct {
	V     int                    `json:"v"`
	Token string                 `json:"token"`
	Op    string                 `json:"op"`
	Args  map[string]interface{} `json:"args"`
}

type bgSocketResponse struct {
	OK     bool        `json:"ok"`
	Error  string      `json:"error,omitempty"`
	Result interface{} `json:"result,omitempty"`
}

// bgJobService answers one session's background-job requests. Everything about
// WHERE a job runs comes from here — the session's own checkout and scratch dir —
// so a request cannot talk the runner into spawning somewhere else.
type bgJobService struct {
	bg         *bgTailer
	token      string
	execDir    string
	scratchDir string
	// Directories other than the checkout that a job may run in. The uploads dir
	// is deliberately outside the checkout so attachments stay out of git.
	extraDirs []string
	env       map[string]string
}

// startBgJobService listens on socketPath until ctx is cancelled, and writes the
// session token the caller must present. Returns the stop func.
func startBgJobService(ctx context.Context, svc *bgJobService, socketPath, tokenPath string) (func(), error) {
	if len(socketPath) > bgSocketPathCap {
		return nil, fmt.Errorf("background job socket path is too long for a unix socket (%d > %d): %s",
			len(socketPath), bgSocketPathCap, socketPath)
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o755); err != nil {
		return nil, err
	}
	// A previous run of this same session left its socket file behind; that run is
	// over (its supervisor is this process's predecessor and has been drained), so
	// the file is stale by construction rather than by guess.
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		listener.Close()
		return nil, err
	}
	if err := os.WriteFile(tokenPath, []byte(svc.token), 0o600); err != nil {
		listener.Close()
		return nil, err
	}

	var wg sync.WaitGroup
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
		case <-done:
		}
		listener.Close()
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				svc.serveConn(conn)
			}()
		}
	}()

	var stopOnce sync.Once
	return func() {
		stopOnce.Do(func() {
			close(done)
			listener.Close()
			wg.Wait()
			_ = os.Remove(socketPath)
			_ = os.Remove(tokenPath)
		})
	}, nil
}

// serveConn runs one exchange: read a request, answer it, close.
func (s *bgJobService) serveConn(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(bgSocketTimeout))
	var req bgSocketRequest
	if err := json.NewDecoder(io.LimitReader(conn, bgSocketRequestCap)).Decode(&req); err != nil {
		writeBgResponse(conn, bgSocketResponse{Error: "malformed request: " + err.Error()})
		return
	}
	if req.V != bgSocketProtocolVersion {
		writeBgResponse(conn, bgSocketResponse{Error: fmt.Sprintf("unsupported protocol version %d", req.V)})
		return
	}
	// The token binds a request to this session run. Same host, same user, many
	// sessions: file permissions cannot tell them apart, and one session's engine
	// must not be able to start or kill another's jobs.
	if s.token == "" || req.Token != s.token {
		writeBgResponse(conn, bgSocketResponse{Error: "background job token is not this session's"})
		return
	}
	writeBgResponse(conn, s.handle(req))
}

func writeBgResponse(conn net.Conn, resp bgSocketResponse) {
	_ = json.NewEncoder(conn).Encode(resp)
}

func (s *bgJobService) handle(req bgSocketRequest) bgSocketResponse {
	args := req.Args
	if args == nil {
		args = map[string]interface{}{}
	}
	switch req.Op {
	case "run":
		dir, err := s.resolveDir(getString(args, "cwd"))
		if err != nil {
			return bgSocketResponse{Error: err.Error()}
		}
		status, err := s.bg.startJob(bgJobSpec{
			Command:     getString(args, "command"),
			Kind:        getString(args, "kind"),
			Dir:         dir,
			ScratchDir:  s.scratchDir,
			Description: getString(args, "description"),
			Env:         mergedBgEnv(s.env, args["env"]),
		})
		if err != nil {
			return bgSocketResponse{Error: err.Error()}
		}
		return bgSocketResponse{OK: true, Result: status}

	case "output":
		tail, err := bgOptionalInt(args, "tail")
		if err != nil {
			return bgSocketResponse{Error: err.Error()}
		}
		since, err := bgOptionalInt(args, "sinceOffset")
		if err != nil {
			return bgSocketResponse{Error: err.Error()}
		}
		if tail > 0 && since > 0 {
			return bgSocketResponse{Error: "pass tail or sinceOffset, not both"}
		}
		out, err := s.bg.jobOutput(getString(args, "jobId"), tail, int64(since))
		if err != nil {
			return bgSocketResponse{Error: err.Error()}
		}
		return bgSocketResponse{OK: true, Result: out}

	case "kill":
		status, err := s.bg.killJob(getString(args, "jobId"), bgKillTeardownGrace)
		if err != nil {
			return bgSocketResponse{Error: err.Error()}
		}
		return bgSocketResponse{OK: true, Result: status}

	case "list":
		return bgSocketResponse{OK: true, Result: map[string]interface{}{
			"jobs": s.bg.listJobs(getBool(args, "includeFinished")), "liveCount": s.bg.liveJobCount(),
		}}
	}
	return bgSocketResponse{Error: "unknown background job operation: " + req.Op}
}

// resolveDir keeps a job inside the session's own directories. An agent asking to
// run somewhere else is asking the runner to write outside the checkout its fence
// protects, which is the one thing this door must not do.
func (s *bgJobService) resolveDir(cwd string) (string, error) {
	if strings.TrimSpace(cwd) == "" {
		return s.execDir, nil
	}
	abs := cwd
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(s.execDir, cwd)
	}
	abs = filepath.Clean(abs)
	for _, root := range append([]string{s.execDir}, s.extraDirs...) {
		if root == "" {
			continue
		}
		if abs == root || strings.HasPrefix(abs, root+string(filepath.Separator)) {
			return abs, nil
		}
	}
	return "", fmt.Errorf("cwd must be inside %s", s.execDir)
}

// mergedBgEnv layers the request's env over the agent's own.
func mergedBgEnv(base map[string]string, raw interface{}) map[string]string {
	merged := map[string]string{}
	for k, v := range base {
		merged[k] = v
	}
	if extra, ok := raw.(map[string]interface{}); ok {
		for k, v := range extra {
			if s, ok := v.(string); ok {
				merged[k] = s
			}
		}
	}
	return merged
}

func bgOptionalInt(args map[string]interface{}, key string) (int, error) {
	switch v := args[key].(type) {
	case nil:
		return 0, nil
	case float64:
		if v < 0 || v != float64(int(v)) {
			return 0, fmt.Errorf("%s must be a non-negative integer", key)
		}
		return int(v), nil
	default:
		return 0, fmt.Errorf("%s must be a non-negative integer", key)
	}
}

// newBgSessionToken mints the per-session credential for the socket.
func newBgSessionToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// bgSocketCall is the client half, used by `orbit mcp` (a child of the engine) to
// reach the runner. One exchange per connection, like the machine broker.
func bgSocketCall(socketPath, token, op string, args map[string]interface{}) (json.RawMessage, error) {
	if socketPath == "" || token == "" {
		return nil, errors.New("this session has no runner-hosted background job socket")
	}
	conn, err := net.DialTimeout("unix", socketPath, bgSocketTimeout)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(bgSocketTimeout))
	req := bgSocketRequest{V: bgSocketProtocolVersion, Token: token, Op: op, Args: args}
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return nil, err
	}
	var resp struct {
		OK     bool            `json:"ok"`
		Error  string          `json:"error"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		return nil, err
	}
	if !resp.OK {
		return nil, errors.New(resp.Error)
	}
	return resp.Result, nil
}

// startSessionBgJobService wires one session's job service: a fresh token per
// run (so a socket left by a predecessor cannot be talked to with an old one)
// and the session's own directories as the only places a job may run.
func startSessionBgJobService(ctx context.Context, bg *bgTailer, job *ClaimedSession, execDir, scratchDir string) (func(), error) {
	token, err := newBgSessionToken()
	if err != nil {
		return nil, err
	}
	svc := &bgJobService{
		bg:         bg,
		token:      token,
		execDir:    execDir,
		scratchDir: scratchDir,
		extraDirs:  []string{uploadsDir(job.SessionID)},
		env:        job.Agent.Env,
	}
	return startBgJobService(ctx, svc, bgSocketPath(job.SessionID), bgTokenPath(job.SessionID))
}
