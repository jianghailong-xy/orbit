package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"sort"
)

// A fleet for the loadgen without a database (src/link-gateway/cmd/loadgen, -fleet): the file loadgen-seed.sh writes
// from the staging stack's tables, with every id drawn from a seed instead. The shape is the cell's planning numbers per
// owner (docs/runner-link-design.md §1.3), as loadgen-seed.sh's: 1.5 runners, 4 open sessions and 0.5 sessions running.
// Sessions go to the runners in turn, so each runner supervises two or three; the running ones are spread evenly over
// the fleet, at most one a runner, so the fleet's first N runners, and every shard of them, carry their share. Each runner
// token names its runner and owner for the stub (token.go).

// fleetRunner is one line of the fleet file, as the loadgen reads it.
type fleetRunner struct {
	Runner   string          `json:"runner"`
	Token    string          `json:"token"`
	Process  string          `json:"process"`
	Sessions []string        `json:"sessions"`
	Active   []activeSession `json:"active"`
}

type activeSession struct {
	ID  string `json:"id"`
	Seq uint64 `json:"seq"`
}

func fleetMain(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("linkstub fleet", flag.ContinueOnError)
	fs.SetOutput(stderr)
	runners := fs.Int("runners", 0, "the runners in the fleet (required)")
	sessions := fs.Int("sessions", 0, "the open sessions across the fleet, at least one a runner (default: 8 for every 3 runners, the cell's 4 an owner)")
	active := fs.Int("active", -1, "how many of them run and stream events, at most one a runner (default: one runner in 3, the cell's 0.5 an owner)")
	seed := fs.Uint64("seed", 1, "the seed every id is drawn from: the same seed writes the same fleet")
	out := fs.String("out", "", "the fleet file to write (default: standard output)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *sessions == 0 {
		*sessions = (*runners*8 + 2) / 3
	}
	if *active < 0 {
		*active = *runners / 3
	}
	if *runners < 1 || *sessions < *runners || *active > *runners {
		fmt.Fprintln(stderr, "linkstub fleet: -runners must be at least 1, -sessions at least -runners, and -active at most -runners")
		return 2
	}
	w := stdout
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			fmt.Fprintln(stderr, "linkstub fleet:", err)
			return 1
		}
		defer f.Close()
		w = f
	}
	bw := bufio.NewWriter(w)
	enc := json.NewEncoder(bw)
	for _, r := range buildFleet(*runners, *sessions, *active, *seed) {
		if err := enc.Encode(r); err != nil {
			fmt.Fprintln(stderr, "linkstub fleet:", err)
			return 1
		}
	}
	if err := bw.Flush(); err != nil {
		fmt.Fprintln(stderr, "linkstub fleet:", err)
		return 1
	}
	fmt.Fprintf(stderr, "linkstub fleet: %d runners, %d sessions, %d of them running\n", *runners, *sessions, *active)
	return 0
}

// buildFleet draws a fleet of runners runners, sessions open sessions and active running ones from seed.
func buildFleet(runners, sessions, active int, seed uint64) []fleetRunner {
	rng := rand.New(rand.NewPCG(seed, 0x6c696e6b73747562))
	owners := make([]string, (runners*2+2)/3) // 1.5 runners an owner
	for i := range owners {
		owners[i] = drawUUID(rng)
	}
	fleet := make([]fleetRunner, runners)
	for i := range fleet {
		id := drawUUID(rng)
		fleet[i] = fleetRunner{Runner: id, Token: runnerToken(id, owners[i%len(owners)]), Process: drawUUID(rng), Active: []activeSession{}}
	}
	for k := 0; k < sessions; k++ {
		r := &fleet[k%runners]
		r.Sessions = append(r.Sessions, drawUUID(rng))
	}
	for j := 0; j < active; j++ {
		r := &fleet[j*runners/active]
		r.Active = append(r.Active, activeSession{ID: r.Sessions[0]})
	}
	for i := range fleet {
		sort.Strings(fleet[i].Sessions)
	}
	return fleet
}

func drawUUID(rng *rand.Rand) string {
	var b [16]byte
	for i := 0; i < 16; i += 8 {
		v := rng.Uint64()
		for j := 0; j < 8; j++ {
			b[i+j] = byte(v >> (8 * j))
		}
	}
	return formatUUID(b)
}
