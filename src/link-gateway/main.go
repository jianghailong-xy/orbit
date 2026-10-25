// Command link-gateway is the runner link's gateway (docs/runner-link-design.md §6.1): the WebSocket endpoint each
// runner keeps one connection to, in place of the daemon's HTTP long polls. It authenticates connections, greets
// them, keeps them alive and drains them. In MODE_HTTP, the shadow period, it compares what runners mirror to it and
// forwards nothing; in MODE_LINK it forwards their requests, heartbeats and events to the apiserver and their live
// streams to NATS (version 1). README.md describes all of it.
package main

import (
	"fmt"
	"os"
)

// version is stamped by the image build (-ldflags "-X main.version=<commit>").
var version = "dev"

const usage = `usage: link-gateway [command]

  serve     serve runners (the default); configured by LINK_* environment variables (README.md)
  dump      decode frames given as base64 or hex lines, or as a length-delimited capture
  client    a test runner: connect, heartbeat, mirror, follow Drain (link-gateway client -h)
  health    exit 0 when this container's gateway answers its health check
  nkey      print a new NATS user nkey pair (seed and public key), for LINK_NATS_SEED and nats.conf
  version   print the version
`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	cmd := "serve"
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "serve":
		return serveMain(args)
	case "dump":
		return dumpMain(args, os.Stdin, os.Stdout, os.Stderr)
	case "client":
		return clientMain(args)
	case "health":
		return healthMain(args)
	case "nkey":
		return nkeyMain(args, os.Stdout, os.Stderr)
	case "version":
		fmt.Println(version)
		return 0
	case "-h", "--help", "help":
		fmt.Print(usage)
		return 0
	default:
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
}
