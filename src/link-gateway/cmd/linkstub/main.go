// Command linkstub stands in for everything the link gateway calls, so that one gateway can be loaded past
// what a staging stack's apiservers and database carry (scripts/runner-link/gateway-limit.sh). It answers each call with
// the smallest answer its route gives that the gateway and a runner take as valid, a fixed delay after the call arrived
// (-delay, 5 ms by default):
//
//   - the gateway's read on LINK_API_URL: the revocation list (nothing revoked);
//   - every call the gateway forwards to LINK_INTERNAL_API_URLS: the welcome route (each session asked about held, its
//     durable seq 0, no release), heartbeats (the answer to a beat that reconciled nothing, as runner_presence gives it,
//     with empty link hints), event batches alone and merged (each stored through its last seq, none refused), and any
//     other runner route a tunnelled request names (200 {});
//   - POST /api/runner/link-token, for the loadgen: a link token for the runner its runner token names, signed with the
//     stub's Ed25519 key, whose public half the gateway trusts (LINK_PUBLIC_KEYS).
//
// It keeps nothing between calls, so several can run side by side, one per backend address. GET /stub/stats says what it
// did: its CPU time, and for each route how many calls it answered and how long they took, with the delay and without.
//
//	linkstub serve -listen 127.0.0.1:62480 -key signing.pem -gateway-token-file gateway-token \
//	  -link-url wss://localhost:62443 -stats-out stub-0.json
//	linkstub fleet -runners 3000 -out fleet.jsonl
//
// `linkstub fleet` writes the loadgen's fleet file without a database: runner, owner, session and process ids drawn from
// a seed, and runner tokens the stub reads the runner and owner from (README.md beside this file).
package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const usage = `usage: linkstub [command] [flags]

  serve   answer the link gateway's calls and the loadgen's link token requests (the default)
  fleet   write a fleet file for the loadgen, with runner tokens this stub accepts

linkstub <command> -h lists each command's flags.
`

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, stdout, stderr io.Writer) int {
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "serve":
		return serveMain(args, stderr)
	case "fleet":
		return fleetMain(args, stdout, stderr)
	case "help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprint(stderr, usage)
		return 2
	}
}

func serveMain(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("linkstub serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	listen := fs.String("listen", "", "the address to answer on, host:port (required)")
	keyFile := fs.String("key", "", "the Ed25519 private key link tokens are signed with, PEM (openssl genpkey -algorithm ed25519) (required)")
	tokenFile := fs.String("gateway-token-file", "", "a file holding the gateway's LINK_GATEWAY_TOKEN, which every call of the gateway must carry (required)")
	linkURL := fs.String("link-url", "", "the link address link tokens name, wss://host:port (required)")
	cell := fs.String("cell", "cell-1", "the cell link tokens are for: the gateway's LINK_CELL_ID")
	delay := fs.Duration("delay", 5*time.Millisecond, "how long after a call arrives its answer is written")
	tokenTTL := fs.Duration("token-ttl", time.Hour, "how long a link token is valid, as the apiserver's (RUNNER_LINK_TOKEN_TTL_SECONDS)")
	statsOut := fs.String("stats-out", "", "write the stats, as GET /stub/stats answers them, to this file on exit")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *listen == "" || *keyFile == "" || *tokenFile == "" || *linkURL == "" {
		fmt.Fprintln(stderr, "linkstub serve needs -listen, -key, -gateway-token-file and -link-url")
		return 2
	}
	if !strings.HasPrefix(*linkURL, "wss://") && !strings.HasPrefix(*linkURL, "ws://") {
		fmt.Fprintf(stderr, "linkstub: -link-url %q is not a ws:// or wss:// address\n", *linkURL)
		return 2
	}
	if *delay < 0 || *tokenTTL <= 0 {
		fmt.Fprintln(stderr, "linkstub: -delay may not be negative, and -token-ttl must be positive")
		return 2
	}
	key, err := readSigningKey(*keyFile)
	if err != nil {
		fmt.Fprintln(stderr, "linkstub:", err)
		return 2
	}
	token, err := os.ReadFile(*tokenFile)
	if err != nil || strings.TrimSpace(string(token)) == "" {
		fmt.Fprintf(stderr, "linkstub: -gateway-token-file %s holds no token\n", *tokenFile)
		return 2
	}
	s := newStub(key, strings.TrimSpace(string(token)), *linkURL, *cell, *delay, *tokenTTL)
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintln(stderr, "linkstub:", err)
		return 1
	}
	srv := &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		// Longer than the gateway keeps an idle backend connection (90 s, backend.go): a server that closes first races
		// the gateway's next call on that connection, which then counts as lost and is sent again.
		IdleTimeout: 10 * time.Minute,
	}
	fmt.Fprintf(stderr, "linkstub: answering on %s after %s; link tokens for %s, cell %s, key %s\n", ln.Addr(), *delay, *linkURL, *cell, s.kid)
	errs := make(chan error, 1)
	go func() { errs <- srv.Serve(ln) }()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	code := 0
	select {
	case err := <-errs:
		fmt.Fprintln(stderr, "linkstub:", err)
		code = 1
	case <-sig:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := srv.Shutdown(ctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
			fmt.Fprintln(stderr, "linkstub:", err)
		}
		cancel()
	}
	if *statsOut != "" {
		if err := writeStats(*statsOut, s.stats()); err != nil {
			fmt.Fprintln(stderr, "linkstub:", err)
			code = 1
		}
	}
	return code
}

// newStub is a stub signing with key, which the gateway's calls must name gatewayToken to.
func newStub(key ed25519.PrivateKey, gatewayToken, linkURL, cell string, delay, tokenTTL time.Duration) *stub {
	return &stub{
		key: key, kid: keyThumbprint(key.Public().(ed25519.PublicKey)), gatewayToken: gatewayToken,
		linkURL: linkURL, cell: cell, delay: delay, tokenTTL: tokenTTL,
		now: time.Now, started: time.Now(), routes: newRouteTable(),
	}
}
