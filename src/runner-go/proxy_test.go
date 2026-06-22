package main

import (
	"strings"
	"testing"
)

func TestHostOnly(t *testing.T) {
	cases := map[string]string{
		"http://10.0.0.202:2086":    "10.0.0.202",
		"https://orbit.example.com": "orbit.example.com",
		"http://host:80/path":       "host",
		"orbit.local:2086":          "orbit.local",
	}
	for in, want := range cases {
		if got := hostOnly(in); got != want {
			t.Errorf("hostOnly(%q)=%q want %q", in, got, want)
		}
	}
}

func TestProxyServiceEnvEmpty(t *testing.T) {
	if proxyServiceEnv("", "http://s:2086", "") != nil {
		t.Fatal("empty proxy should yield nil")
	}
}

func TestProxyServiceEnv(t *testing.T) {
	vars := proxyServiceEnv("http://127.0.0.1:7890", "http://10.0.0.202:2086", "corp.local")
	m := map[string]string{}
	for _, e := range vars {
		m[e.K] = e.V
	}
	for _, k := range []string{"http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"} {
		if m[k] != "http://127.0.0.1:7890" {
			t.Errorf("%s=%q want proxy url", k, m[k])
		}
	}
	np := m["no_proxy"]
	for _, want := range []string{"localhost", "10.0.0.202", "corp.local"} {
		if !strings.Contains(np, want) {
			t.Errorf("no_proxy %q missing %q", np, want)
		}
	}
	if m["no_proxy"] != m["NO_PROXY"] {
		t.Error("no_proxy and NO_PROXY should match")
	}
}

func TestProxyEnvFormatters(t *testing.T) {
	if systemdProxyEnv(nil) != "" || launchdProxyEnv(nil) != "" {
		t.Fatal("nil vars should format to empty")
	}
	vars := []envVar{{"http_proxy", "http://p:7890"}, {"no_proxy", "localhost,h"}}
	if !strings.Contains(systemdProxyEnv(vars), "Environment=http_proxy=http://p:7890\n") {
		t.Errorf("systemd format wrong: %q", systemdProxyEnv(vars))
	}
	if !strings.Contains(launchdProxyEnv(vars), "<key>http_proxy</key><string>http://p:7890</string>") {
		t.Errorf("launchd format wrong: %q", launchdProxyEnv(vars))
	}
}
