package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"orbit/link-gateway/linkpb"
)

// The mode runners are told (docs/runner-link-design.md §11.3, §11.4; task D0). The cut-over and its first rollback are
// one switch on the server, RUNNER_LINK_REQUIRED, which an administrator flips at runtime. The gateway reads it from
// GET /api/runner/link/mode with its secret every ModeInterval, and tells runners MODE_LINK while it is on and MODE_HTTP
// while it is off: in each Welcome, and in each HeartbeatAck, so a runner already connected hears of a change at its
// next heartbeat. LINK_MODE=link pins MODE_LINK whatever the switch says, as before the switch existed.
//
// A connection keeps what it was opened with: one opened in MODE_LINK has what forwarding needs, one opened in MODE_HTTP
// compares mirrors and forwards nothing (conn.go). A runner told MODE_LINK on a MODE_HTTP connection opens a new
// connection for its work (src/runner-go/link_mode.go). Once the switch is off, a connection opened in MODE_LINK
// forwards no more heartbeats and calls: a beat is answered MODE_HTTP, and a call refused LINK_MODE_HTTP, both without
// reaching a backend, and the runner sends them again over HTTPS. Its event batches are still forwarded until the
// runner leaves it: each seq is stored once (src/apiserver/src/runner-api/link-events.ts), so nothing is lost or
// stored twice whichever way an event reaches the server.
//
// A read that fails changes nothing: runners are told the mode last read, so a database or apiserver blip does not
// move every runner between the link and HTTPS. Until a read succeeds, they are told MODE_HTTP, what LINK_MODE says.

// modeResponse is RunnerLinkModeResponse in src/apiserver/src/runner-api/runner-link-required.controller.ts.
type modeResponse struct {
	Required *bool `json:"required"`
}

// mode is what runners are told now.
func (g *gateway) mode() linkpb.Mode {
	if g.cfg.Mode == linkpb.Mode_MODE_LINK || g.linkRequired.Load() {
		return linkpb.Mode_MODE_LINK
	}
	return linkpb.Mode_MODE_HTTP
}

// modeGauge is link_mode_link's value for mode.
func modeGauge(mode linkpb.Mode) float64 {
	if mode == linkpb.Mode_MODE_LINK {
		return 1
	}
	return 0
}

// setLinkRequired takes the switch as read.
func (g *gateway) setLinkRequired(required bool) {
	before := g.mode()
	g.linkRequired.Store(required)
	after := g.mode()
	g.metrics.mode.set(modeGauge(after))
	if after != before {
		g.log.Info("RUNNER_LINK_REQUIRED switched: runners are told "+after.String(), "required", required)
	}
}

// modePoller reads the switch.
type modePoller struct {
	url    string
	token  string
	client *http.Client
	g      *gateway
	// failing is the failure last logged: a failure is logged when it starts or changes, and the recovery once.
	failing string
}

// fetch reads the switch once and, when it was read, takes it. On any failure the mode in hand stays as it is.
func (p *modePoller) fetch(ctx context.Context) error {
	m := p.g.metrics
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+p.token)
	resp, err := p.client.Do(req)
	if err != nil {
		m.modeFetches.inc("error")
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		m.modeFetches.inc("error")
		return err
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		m.modeFetches.inc("unauthorized")
		return fmt.Errorf("the apiserver refused LINK_GATEWAY_TOKEN (401): it must equal the apiserver's RUNNER_LINK_GATEWAY_TOKEN")
	case resp.StatusCode == http.StatusNotFound:
		m.modeFetches.inc("not_configured")
		return fmt.Errorf("the apiserver answered 404: its runner link is off, or it is older than the RUNNER_LINK_REQUIRED switch")
	case resp.StatusCode != http.StatusOK:
		m.modeFetches.inc("error")
		return fmt.Errorf("the apiserver answered %d", resp.StatusCode)
	}
	var answer modeResponse
	if err := json.Unmarshal(body, &answer); err != nil || answer.Required == nil {
		m.modeFetches.inc("error")
		return fmt.Errorf("the answer does not say whether RUNNER_LINK_REQUIRED is on: %.200q", body)
	}
	p.g.setLinkRequired(*answer.Required)
	m.modeFetches.inc("ok")
	return nil
}

// report logs what a fetch came to, when that differs from what the fetch before it came to.
func (p *modePoller) report(err error) {
	switch {
	case err == nil && p.failing != "":
		p.g.log.Info("RUNNER_LINK_REQUIRED read again", "mode", p.g.mode().String())
		p.failing = ""
	case err != nil && err.Error() != p.failing:
		p.g.log.Error("RUNNER_LINK_REQUIRED not read; runners are told the mode last read", "mode", p.g.mode().String(), "err", err)
		p.failing = err.Error()
	}
}

// run reads the switch every interval until ctx ends.
func (p *modePoller) run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := p.fetch(ctx); ctx.Err() == nil {
				p.report(err)
			}
		}
	}
}
