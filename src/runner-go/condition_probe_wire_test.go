package main

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

// The server's heartbeat answer for one condition, as the apiserver writes it: conditions.pg.spec.ts
// (heartbeat-wire-fixture) holds the real answer of RunnerApiController.heartbeat equal to this file, byte for byte,
// once the condition's id is the fixture's. Decoded here with this runner's own types, unknown fields refused, so a
// name either side changes fails one of the two.
func TestConditionProbeWireFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/condition-probe/heartbeat-answer.json")
	if err != nil {
		t.Fatal(err)
	}
	var answer struct {
		ConditionProbes *[]ConditionProbe `json:"conditionProbes"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&answer); err != nil {
		t.Fatalf("the server's conditionProbes does not decode as ConditionProbe: %v", err)
	}
	if answer.ConditionProbes == nil || len(*answer.ConditionProbes) != 1 {
		t.Fatalf("want one probe, got %+v", answer.ConditionProbes)
	}
	p := (*answer.ConditionProbes)[0]
	if p.ID != "01937a6e-0000-7000-8000-00000000c0de" {
		t.Errorf("id did not arrive: %q", p.ID)
	}
	if p.WorkDir != "/srv/wire" {
		t.Errorf("workDir did not arrive: %q", p.WorkDir)
	}
	if p.Env["CEPH_CONF"] != "/etc/ceph/ceph.conf" || len(p.Env) != 1 {
		t.Errorf("env did not arrive: %v", p.Env)
	}
	if p.TimeoutSeconds != 20 || p.IntervalSeconds != 300 {
		t.Errorf("timeout and interval did not arrive: %d %d", p.TimeoutSeconds, p.IntervalSeconds)
	}
	if p.CommandHash != conditionProbeCommandHash(p.Command) {
		t.Errorf("commandHash %q is not the SHA-256 of the command the runner would check it against", p.CommandHash)
	}
	// And through the whole answer type the heartbeat decodes into.
	var full HeartbeatResponse
	if err := json.Unmarshal(raw, &full); err != nil {
		t.Fatal(err)
	}
	if full.ConditionProbes == nil || (*full.ConditionProbes)[0].ID != p.ID {
		t.Fatalf("HeartbeatResponse.ConditionProbes did not carry the probe: %+v", full.ConditionProbes)
	}
}
