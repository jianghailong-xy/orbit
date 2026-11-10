package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// `orbit secret exec NAME -- command…` (docs/design/owner-request-secrets.md §5.1): the one way an ENV secret reaches a
// program. The CLI asks the runner for a lease on the session's own socket (op secret_lease), starts the command with
// the variable added to that command's environment and to nothing else, and passes the command's output through the
// exact-value scrubber before writing it out. It holds the lease while the command runs: a revocation ends the
// command, a runner that restarts is asked again, and with no answer the command stops at the grant's expiry.
//
// The CLI starts the command, not the runner, so the command stays under the engine's own sandbox and permission
// check. The value never travels in an argv, an engine's environment, a claim or a bg_run card.

const secretHelp = `orbit secret — use a secret the account owner delivered to this runner

Usage:
  orbit secret exec NAME -- COMMAND [ARGS...]

Runs COMMAND with the environment variable NAME set to the secret the owner delivered for this
session or its task (request_owner_action, kind SECRET, envVar NAME). Only COMMAND gets it: not
this shell, not the coding engine. What COMMAND prints is scrubbed of the value, raw or encoded,
before it is written out. If the owner revokes the secret, or it is removed when its task or
session ends, COMMAND is stopped (SIGTERM, then SIGKILL 10 s later).

Run it inside an Orbit session: it reaches the runner through the session's socket
(ORBIT_SESSION_ID). If the engine's sandbox forbids that connection, run the same command line
with bg_run.
`

// secretExecKillGrace is how long a revoked command has between SIGTERM and SIGKILL.
var secretExecKillGrace = 10 * time.Second

// secretExecRetryEvery is how often a command whose lease connection was lost asks again.
var secretExecRetryEvery = 2 * time.Second

// cmdSecret is `orbit secret …`, returning the process's exit status.
func cmdSecret(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		fmt.Fprint(stdout, secretHelp)
		if len(args) == 0 {
			return 2
		}
		return 0
	}
	if args[0] != "exec" {
		fmt.Fprintf(stderr, "orbit secret: unknown command %q\n\n%s", args[0], secretHelp)
		return 2
	}
	rest := args[1:]
	if len(rest) > 0 && (rest[0] == "--help" || rest[0] == "-h") {
		fmt.Fprint(stdout, secretHelp)
		return 0
	}
	if len(rest) == 0 {
		fmt.Fprintf(stderr, "orbit secret exec: NAME is required\n\n%s", secretHelp)
		return 2
	}
	name, command := rest[0], rest[1:]
	if len(command) > 0 && command[0] == "--" {
		command = command[1:]
	}
	if len(command) == 0 {
		fmt.Fprintf(stderr, "orbit secret exec: a command is required after NAME --\n\n%s", secretHelp)
		return 2
	}
	if !secretEnvVarPattern.MatchString(name) {
		fmt.Fprintf(stderr, "orbit secret exec: NAME %q must match ^[A-Z][A-Z0-9_]{0,63}$\n", name)
		return 2
	}
	socket, err := secretLeaseSocket()
	if err != nil {
		fmt.Fprintln(stderr, "orbit secret exec:", err)
		return 1
	}
	return runSecretExec(socket, name, command, stdin, stdout, stderr)
}

// secretLeaseSocket is the session's socket: the one the engine was handed, or the one its session id names.
func secretLeaseSocket() (string, error) {
	if socket := os.Getenv(envBgSocket); socket != "" {
		return socket, nil
	}
	if sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID")); sessionID != "" {
		return bgSocketPath(sessionID), nil
	}
	return "", errors.New("this is not an Orbit session (ORBIT_SESSION_ID is not set), so there is no runner to ask for the secret")
}

// secretLeaseToken is the session token, read again on every connection: a runner that restarted wrote a new one
// beside the socket.
func secretLeaseToken(socket string) string {
	if data, err := os.ReadFile(filepath.Join(filepath.Dir(socket), "bg.token")); err == nil {
		if token := strings.TrimSpace(string(data)); token != "" {
			return token
		}
	}
	return os.Getenv(envBgToken)
}

// secretLease is what the runner answers a lease with.
type secretLease struct {
	GrantID   string `json:"grantId"`
	ExpiresAt string `json:"expiresAt"`
	Value     string `json:"value"`
}

// errLeaseRefused is the runner's definite no, as opposed to a runner that could not be reached.
type errLeaseRefused struct{ msg string }

func (e *errLeaseRefused) Error() string { return e.msg }

// dialSecretLease opens a lease. The connection stays open for as long as the lease is held.
func dialSecretLease(socket, name string) (net.Conn, *json.Decoder, *secretLease, error) {
	token := secretLeaseToken(socket)
	if token == "" {
		return nil, nil, nil, fmt.Errorf("cannot read this session's socket token beside %s", socket)
	}
	conn, err := net.DialTimeout("unix", socket, bgSocketTimeout)
	if err != nil {
		return nil, nil, nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(bgSocketTimeout))
	req := bgSocketRequest{V: bgSocketProtocolVersion, Token: token, Op: "secret_lease", Args: map[string]interface{}{"name": name}}
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		conn.Close()
		return nil, nil, nil, err
	}
	dec := json.NewDecoder(conn)
	var resp struct {
		OK     bool         `json:"ok"`
		Error  string       `json:"error"`
		Result *secretLease `json:"result"`
	}
	if err := dec.Decode(&resp); err != nil {
		conn.Close()
		return nil, nil, nil, err
	}
	if !resp.OK || resp.Result == nil || resp.Result.Value == "" {
		conn.Close()
		msg := resp.Error
		if msg == "" {
			msg = "the runner gave no lease"
		}
		return nil, nil, nil, &errLeaseRefused{msg}
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, dec, resp.Result, nil
}

// leaseMessage is what the runner sends on a held lease.
type leaseMessage struct {
	Revoked bool   `json:"revoked"`
	Reason  string `json:"reason"`
}

func runSecretExec(socket, name string, command []string, stdin io.Reader, stdout, stderr io.Writer) int {
	conn, dec, lease, err := dialSecretLease(socket, name)
	if err != nil {
		var refused *errLeaseRefused
		if errors.As(err, &refused) {
			fmt.Fprintln(stderr, "orbit secret exec:", refused.msg)
			return 1
		}
		fmt.Fprintf(stderr, "orbit secret exec: cannot reach the runner on this session's socket %s (%v)."+
			" If this shell runs in the coding engine's sandbox, which may forbid that connection, run the same"+
			" command line with bg_run instead.\n", socket, err)
		return 1
	}
	expires, err := time.Parse(time.RFC3339Nano, lease.ExpiresAt)
	if err != nil {
		conn.Close()
		fmt.Fprintln(stderr, "orbit secret exec: the runner's lease has an unreadable expiry")
		return 1
	}
	scrub := newSecretRedactor([]string{lease.Value})
	outW, errW := newSecretScrubWriter(stdout, scrub), newSecretScrubWriter(stderr, scrub)

	cmd := exec.Command(command[0], command[1:]...)
	env := make([]string, 0, len(os.Environ())+1)
	for _, entry := range os.Environ() {
		if key, _, _ := strings.Cut(entry, "="); key != name {
			env = append(env, entry)
		}
	}
	cmd.Env = append(env, name+"="+lease.Value)
	lease.Value = ""
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, outW, errW
	secretExecPrepare(cmd)
	if err := cmd.Start(); err != nil {
		conn.Close()
		fmt.Fprintln(stderr, "orbit secret exec:", err)
		return 127
	}

	// Read once: the goroutines below may outlive this call's caller.
	grace, retryEvery := secretExecKillGrace, secretExecRetryEvery
	exited := make(chan struct{})
	stopped := make(chan string, 1)
	stop := func(reason string) {
		select {
		case stopped <- reason:
		default:
			return
		}
		secretExecSignal(cmd, syscall.SIGTERM)
		go func() {
			select {
			case <-exited:
			case <-time.After(grace):
				secretExecSignal(cmd, syscall.SIGKILL)
			}
		}()
	}
	// The command's own signals go to its whole group.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	go func() {
		for {
			select {
			case sig := <-signals:
				if s, ok := sig.(syscall.Signal); ok {
					secretExecSignal(cmd, s)
				}
			case <-exited:
				return
			}
		}
	}()
	go holdSecretLease(socket, name, lease.GrantID, conn, dec, expires, retryEvery, exited, stop)

	waitErr := cmd.Wait()
	close(exited)
	_ = outW.Close()
	_ = errW.Close()
	select {
	case reason := <-stopped:
		fmt.Fprintln(stderr, "orbit secret exec: stopped the command:", reason)
	default:
	}
	return secretExecStatus(cmd, waitErr)
}

// holdSecretLease keeps the lease until the command exits. A revocation stops the command. A lost connection is a
// runner that restarted, or is restarting: it is asked again every secretExecRetryEvery, a refusal then stops the
// command, and with no answer the command stops at the grant's expiry.
func holdSecretLease(socket, name, grantID string, conn net.Conn, dec *json.Decoder, expires time.Time, retryEvery time.Duration,
	exited <-chan struct{}, stop func(string)) {
	for {
		lost := make(chan leaseMessage, 1)
		go func(dec *json.Decoder) {
			var msg leaseMessage
			if err := dec.Decode(&msg); err != nil {
				msg = leaseMessage{}
			}
			lost <- msg
		}(dec)
		var msg leaseMessage
		expiry := time.NewTimer(time.Until(expires))
		select {
		case <-exited:
			expiry.Stop()
			conn.Close()
			return
		case <-expiry.C:
			conn.Close()
			stop("the secret " + name + " expired")
			return
		case msg = <-lost:
			expiry.Stop()
			conn.Close()
		}
		if msg.Revoked {
			reason := msg.Reason
			if reason == "" {
				reason = "the secret " + name + " was revoked"
			}
			stop(reason)
			return
		}
		for {
			wait := retryEvery
			if left := time.Until(expires); left < wait {
				wait = left
			}
			if wait <= 0 {
				stop("the secret " + name + " expired while the runner could not be reached")
				return
			}
			select {
			case <-exited:
				return
			case <-time.After(wait):
			}
			next, nextDec, lease, err := dialSecretLease(socket, name)
			var refused *errLeaseRefused
			if errors.As(err, &refused) {
				stop(refused.msg)
				return
			}
			if err == nil {
				// The same name may now be another grant (the owner asked again): not the one this command
				// was started with.
				if lease.GrantID != grantID {
					next.Close()
					stop("the secret " + name + " was replaced by another delivery; run the command again")
					return
				}
				if at, perr := time.Parse(time.RFC3339Nano, lease.ExpiresAt); perr == nil {
					expires = at
				}
				conn, dec = next, nextDec
				break
			}
		}
	}
}

// secretExecStatus is the exit status the CLI passes on: the command's own, or 128 plus the signal that ended it.
func secretExecStatus(cmd *exec.Cmd, err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return 128 + int(status.Signal())
		}
		return exitErr.ExitCode()
	}
	return 1
}

// --- the runner's side of the socket -----------------------------------------------------------------------------

// serveSecretLease answers secret_lease on a session's socket and holds the connection for as long as the lease
// lasts. Only an ENV grant delivered for this session, or for its task, is leased.
func (s *bgJobService) serveSecretLease(conn net.Conn, args map[string]interface{}) {
	name := getString(args, "name")
	if err := checkSecretEnvVar(name); err != nil {
		writeBgResponse(conn, bgSocketResponse{Error: err.Error()})
		return
	}
	if s.secrets == nil {
		writeBgResponse(conn, bgSocketResponse{Error: "this runner holds no secrets"})
		return
	}
	// A runner that has just started has not fetched its live grants again yet; answer once it has.
	ctx := s.leaseCtx
	if ctx == nil {
		ctx = context.Background()
	}
	s.secrets.waitReady(ctx, bgSocketTimeout-5*time.Second)
	held, err := s.secrets.lease(name, s.sessionID, s.taskID)
	if err != nil {
		writeBgResponse(conn, bgSocketResponse{Error: err.Error()})
		return
	}
	writeBgResponse(conn, bgSocketResponse{OK: true, Result: secretLease{
		GrantID: held.id, ExpiresAt: held.expiresAt.UTC().Format(time.RFC3339Nano), Value: string(held.value),
	}})
	_ = conn.SetDeadline(time.Time{})
	gone := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, conn)
		close(gone)
	}()
	select {
	case <-held.revoked:
		_ = json.NewEncoder(conn).Encode(leaseMessage{Revoked: true, Reason: "the secret " + name + " was removed from this runner"})
	case <-s.sessionEnded:
		_ = json.NewEncoder(conn).Encode(leaseMessage{Revoked: true, Reason: "the session ended"})
	case <-gone:
	case <-s.leaseStop:
	case <-ctx.Done():
	}
}

// secretScan answers secret_scan: whether the file at path holds a value this runner holds. `orbit mcp` asks it for a
// file it is about to upload (local_file.go), since only the runner process holds the values.
func (s *bgJobService) secretScan(path string) bgSocketResponse {
	holds, err := secretFileHoldsValue(s.secrets, path)
	if err != nil {
		return bgSocketResponse{Error: err.Error()}
	}
	return bgSocketResponse{OK: true, Result: map[string]interface{}{"holds": holds}}
}

func secretFileHoldsValue(store *secretStore, path string) (bool, error) {
	if store.scrubber() == nil {
		return false, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, errors.New("not a regular file")
	}
	return store.readerHolds(file)
}
