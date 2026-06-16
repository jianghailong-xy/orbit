package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Transport is an outbound-only HTTP client to the control plane.
type Transport struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewTransport(baseURL, token string) *Transport {
	return &Transport{baseURL: baseURL, token: token, client: &http.Client{}}
}

func (t *Transport) do(ctx context.Context, method, path string, body, out interface{}, timeout time.Duration) error {
	if ctx == nil {
		ctx = context.Background()
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(cctx, method, t.baseURL+"/api"+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	if t.token != "" {
		req.Header.Set("authorization", "Bearer "+t.token)
	}
	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s -> %d %s", method, path, resp.StatusCode, string(data))
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

func (t *Transport) deviceStart(b DeviceStartRequest) (*DeviceStartResponse, error) {
	var r DeviceStartResponse
	if err := t.do(nil, "POST", "/runner/device/start", b, &r, 35*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

func (t *Transport) devicePoll(deviceCode string) (*DevicePollResponse, error) {
	var r DevicePollResponse
	body := map[string]string{"deviceCode": deviceCode}
	if err := t.do(nil, "POST", "/runner/device/poll", body, &r, 15*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

func (t *Transport) register(b RegisterRequest) (*RegisterResponse, error) {
	var r RegisterResponse
	if err := t.do(nil, "POST", "/runner/register", b, &r, 35*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

func (t *Transport) deregister() error {
	return t.do(nil, "POST", "/runner/deregister", nil, nil, 15*time.Second)
}

func (t *Transport) heartbeat(b HeartbeatRequest) (*HeartbeatResponse, error) {
	var r HeartbeatResponse
	if err := t.do(nil, "POST", "/runner/heartbeat", b, &r, 15*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

func (t *Transport) me() (*MeResponse, error) {
	var r MeResponse
	if err := t.do(nil, "GET", "/runner/me", nil, &r, 10*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

// claimJob long-polls; returns nil when the server holds then yields nothing.
func (t *Transport) claimJob(ctx context.Context) (*ClaimedJob, error) {
	var r ClaimedJob
	if err := t.do(ctx, "GET", "/runner/jobs", nil, &r, 35*time.Second); err != nil {
		return nil, err
	}
	if r.RunID == "" {
		return nil, nil
	}
	return &r, nil
}

func (t *Transport) postEvents(runID string, batch RunEventBatch) error {
	return t.do(nil, "POST", "/runner/runs/"+runID+"/events", batch, nil, 35*time.Second)
}

func (t *Transport) complete(runID string, b CompleteRequest) error {
	return t.do(nil, "POST", "/runner/runs/"+runID+"/complete", b, nil, 35*time.Second)
}

// inbox long-polls for the next user turn of an interactive session; returns nil
// when the server holds then yields nothing (turnId == "").
func (t *Transport) inbox(ctx context.Context, runID string) (*RunInboxResponse, error) {
	var r RunInboxResponse
	if err := t.do(ctx, "GET", "/runner/runs/"+runID+"/inbox", nil, &r, 35*time.Second); err != nil {
		return nil, err
	}
	if r.TurnID == "" {
		return nil, nil
	}
	return &r, nil
}

func (t *Transport) turnComplete(runID string, b TurnCompleteRequest) error {
	return t.do(nil, "POST", "/runner/runs/"+runID+"/turn-complete", b, nil, 35*time.Second)
}
