package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// `orbit notify` — the CLI half of the MCP notify tool. Inside a session it is the same call the
// agent makes (ORBIT_SESSION_ID titles the alert and routes a tap); headless it is how a cron job
// or a shell script reaches the runner's owner, which nothing else on this CLI could do.
//
// Flat rather than a resource family: there is one thing to do with a notification, and
// `orbit notify send --message` would be a noun that never gains a second verb.

const notifyHelp = `orbit notify — alert this account's devices with a line you write

Usage:
  orbit notify --message TEXT [--json]

Pushes one line to the phones and Macs registered to the runner's owner. Inside a session
the alert is titled with that session and a tap on it opens the session; run headless it is
titled with the runner's name.

For the moments nobody is watching the transcript: you need an answer only a human can give,
or the thing they were waiting on is done. The message is read on a lock screen — past ~200
characters it is cut — and at most one per session per minute is delivered.

The result reports whether anything was actually sent. "delivered": false with a "reason"
means nobody was alerted (no registered device, the account turned these off, or this session
already alerted them within the last minute) — the exit status is still 0, because the call
worked; it is the answer that says nobody was told.
`

var notifyCLICapabilities = []cliCapabilitySpec{
	{
		Tool:        "notify",
		Argv:        []string{"orbit", "notify"},
		Usage:       "orbit notify --message TEXT [--json]",
		Arguments:   []string{"--message <text> (required)", "--json"},
		Description: "Alert the human this runs for on their devices, with a line you write. For when you need something only they can give and are otherwise stuck, or the thing they were waiting for is done — not for progress updates. Inside a session they can reply from the notification. At most one per session per minute; read the result, which says whether anybody was actually alerted.",
		Mutates:     true,
	},
}

func cmdNotifyCLI(args []string, out io.Writer) error {
	if wantsHelp(args) {
		_, err := fmt.Fprint(out, notifyHelp)
		return err
	}
	fs := newCLIFlagSet("orbit notify")
	message := fs.String("message", "", "the line to show")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if *message == "" {
		return fmt.Errorf("--message is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// Unlike a task write this carries no attribution — the recipient is the runner's owner
	// whoever asks — so the session id is only the alert's title and tap target. Absent headless.
	raw, err := t.notify(strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID")), *message)
	if err != nil {
		return fmt.Errorf("notify: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}
