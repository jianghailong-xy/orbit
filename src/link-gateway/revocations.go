package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// The deny list (docs/runner-link-design.md §6.2): the fingerprints of the runner credentials the apiserver has
// revoked within a token's lifetime, read from GET /api/runner/link-token/revocations with the gateway's secret. The
// upgrade path only looks it up in memory; it never waits on the apiserver.

type denyList struct {
	mu  sync.RWMutex
	set map[string]struct{}
}

func (d *denyList) revoked(credential string) bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	_, ok := d.set[credential]
	return ok
}

func (d *denyList) replace(set map[string]struct{}) {
	d.mu.Lock()
	d.set = set
	d.mu.Unlock()
}

func (d *denyList) size() int {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return len(d.set)
}

// revocationsResponse is RunnerLinkRevocationsResponse in runner-link-token.controller.ts.
type revocationsResponse struct {
	Since       string `json:"since"`
	Revocations []struct {
		Credential string `json:"credential"`
		RevokedAt  string `json:"revokedAt"`
	} `json:"revocations"`
}

type revocationPoller struct {
	url     string
	token   string
	client  *http.Client
	deny    *denyList
	metrics *gatewayMetrics
	log     *slog.Logger
	// revoked is told every list that was read, so connections whose credential is on it can be closed.
	revoked func(set map[string]struct{})
}

// fetch reads the list once and, when it was read, replaces the deny list with it. The list covers the whole
// window in which a revocation can still refuse a token, so replacing is right: a credential that left it can
// refuse nothing any more. On any failure the list in hand stays as it is.
func (p *revocationPoller) fetch(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+p.token)
	resp, err := p.client.Do(req)
	if err != nil {
		p.metrics.revocationFetches.inc("error")
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		p.metrics.revocationFetches.inc("error")
		return err
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		p.metrics.revocationFetches.inc("unauthorized")
		return fmt.Errorf("the apiserver refused LINK_GATEWAY_TOKEN (401): it must equal the apiserver's RUNNER_LINK_GATEWAY_TOKEN")
	case resp.StatusCode == http.StatusNotFound:
		p.metrics.revocationFetches.inc("not_configured")
		return fmt.Errorf("the apiserver answered 404: its runner link is off (RUNNER_LINK_SIGNING_KEY, RUNNER_LINK_URL and RUNNER_LINK_GATEWAY_TOKEN must all be set)")
	case resp.StatusCode != http.StatusOK:
		p.metrics.revocationFetches.inc("error")
		return fmt.Errorf("the apiserver answered %d", resp.StatusCode)
	}
	var list revocationsResponse
	if err := json.Unmarshal(body, &list); err != nil {
		p.metrics.revocationFetches.inc("error")
		return fmt.Errorf("the revocation list does not decode: %v", err)
	}
	set := make(map[string]struct{}, len(list.Revocations))
	for _, r := range list.Revocations {
		if r.Credential != "" {
			set[r.Credential] = struct{}{}
		}
	}
	p.deny.replace(set)
	p.metrics.revocationFetches.inc("ok")
	p.metrics.revocationLastSuccess.set(float64(time.Now().Unix()))
	if p.revoked != nil {
		p.revoked(set)
	}
	return nil
}

// run reads the list every interval until ctx ends, logging each failure.
func (p *revocationPoller) run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := p.fetch(ctx); err != nil && ctx.Err() == nil {
				p.log.Error("revocation list not read; the deny list in hand stays", "err", err, "revoked", p.deny.size())
			}
		}
	}
}
