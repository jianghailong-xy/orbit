//go:build !linux

package main

import "testing"

func TestAntigravityGoogleLoginUnsupportedPlatform(t *testing.T) {
	var result LoginResultRequest
	(&loginRelay{}).start(LoginCommand{Engine: providerAntigravity, Attempt: "unsupported"}, func(r LoginResultRequest) { result = r })
	if result.Status != loginFailed || result.Message != "Antigravity 的 Google 登录暂时只支持 Linux runner" || result.Attempt != "unsupported" {
		t.Fatalf("unexpected platform response: %+v", result)
	}
}
