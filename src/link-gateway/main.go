// Command link-gateway is the runner link's gateway (docs/runner-link-design.md §6.1): the WebSocket endpoint each
// runner keeps one connection to, in place of the daemon's HTTP long polls. Version 0 is the connection layer only:
// it authenticates connections, greets them, keeps them alive, drains them, and compares what runners mirror to it
// during the shadow period. It forwards nothing to the control plane yet. README.md describes all of it.
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
