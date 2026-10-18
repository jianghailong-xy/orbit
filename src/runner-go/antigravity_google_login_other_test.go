//go:build !linux

package main

import "testing"

func TestAntigravityGoogleLoginUnsupportedPlatform(t *testing.T) {
	var result LoginResultRequest
	(&loginRelay{}).start(LoginCommand{Engine: providerAntigravity, Attempt: "unsupported"}, func(r LoginResultRequest) { result = r })
	if result.Status != loginFailed || result.Message != "Signing Antigravity in with Google works only on a Linux runner for now." || result.Attempt != "unsupported" {
		t.Fatalf("unexpected platform response: %+v", result)
	}
}
