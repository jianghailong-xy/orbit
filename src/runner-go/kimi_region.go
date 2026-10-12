package main

// Kimi Code's two sign-in sites.
//
// kimi.com (`mainland-cn`) and kimi.ai (`global`) keep accounts, sign-in pages and APIs of their own,
// so an account of one cannot sign in on the other. A bare `kimi login` picks the site itself: the one
// its last login was on, else the one its installer came from (`<KIMI_CODE_HOME>/region`, which
// Orbit's code.kimi.com installer makes kimi.com). Only `--region` lets the user say which.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const (
	kimiRegionMainland = "mainland-cn"
	kimiRegionGlobal   = "global"
)

// kimiLoginRegionCapabilityV1 declares that this runner signs Kimi Code in on the site a LoginCommand
// names (Region). One that ignored it would run a bare `kimi login` and sign in wherever the CLI
// decided, so the control plane hands a start naming a site only to a process that declares this.
const kimiLoginRegionCapabilityV1 = "kimi-login-region/v1"

// kimiManagedProvider is the provider Kimi Code's own login writes into config.toml.
const kimiManagedProvider = "managed:kimi-code"

// kimiLoginArgv is `kimi login` on the site region names, or what to tell the user instead.
//
// A Kimi Code too old to know `--region` signs in where it always did — kimi.com, on an install
// Orbit made — so kimi.com is a bare login there, and kimi.ai is refused in words the user can act
// on rather than quietly signed in on the other site.
//
// env is the environment the sign-in runs in (nil: this process's own, Default's): its help is asked
// there too, so asking about an account's sign-in runs nothing in Default's home.
func kimiLoginArgv(argv []string, region string, env []string) ([]string, string) {
	if region != kimiRegionMainland && region != kimiRegionGlobal {
		return nil, "unknown Kimi site " + strconv.Quote(region) + " — start the sign-in again"
	}
	spec, _ := specFor(providerKimi)
	if path, ok := lookLoginEngine(providerKimi); ok && loginHelpMentions(path, spec, env, "--region") {
		return append(argv, "--region", region), ""
	}
	if region == kimiRegionGlobal {
		return nil, "this runner's Kimi Code is too old to sign in on kimi.ai — update this machine's engines from its runner page, then try again"
	}
	return argv, ""
}

// askKimiRegion asks `orbit doctor`'s user which site their Kimi account is on, until they say. ""
// when stdin is gone: the bare `kimi login` the doctor always ran.
func askKimiRegion() string {
	for {
		fmt.Print("  Which Kimi account are you signing in with?\n    1) kimi.com — Mainland China\n    2) kimi.ai — International\n  [1/2] ")
		line, err := stdinReader.ReadString('\n')
		switch strings.ToLower(strings.TrimSpace(line)) {
		case "1", "kimi.com":
			return kimiRegionMainland
		case "2", "kimi.ai":
			return kimiRegionGlobal
		}
		if err != nil {
			return ""
		}
	}
}

// probeKimiLoginRegion asks the CLI which site its own login is on. Config only, like the model
// catalog's read of the same command: no session, no network, no LLM call. env is the CLI's
// environment (nil: this process's own), so one account's KIMI_CODE_HOME can be asked instead of
// Default's.
func probeKimiLoginRegion(binPath string, env []string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binPath, "provider", "list", "--json")
	cmd.Env = env
	// Output(), not CombinedOutput(): the payload carries every configured provider's api_key, which
	// must not reach a log. Nothing but the site is kept from it.
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return parseKimiLoginRegion(out)
}

// parseKimiLoginRegion reads the site off the managed Kimi Code provider in `kimi provider list
// --json`, the way the CLI itself resolves it: the OAuth host the login persisted, then the default
// slot's key (only ever a kimi.com login, which persists no host), then the API it points at. No
// managed provider — never signed in, or signed out — is no site: an installer's default is not a
// sign-in.
func parseKimiLoginRegion(out []byte) string {
	start := bytes.IndexByte(out, '{')
	if start < 0 {
		return ""
	}
	var raw struct {
		Providers map[string]struct {
			BaseURL string `json:"baseUrl"`
			OAuth   *struct {
				Key       string `json:"key"`
				OAuthHost string `json:"oauthHost"`
			} `json:"oauth"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(out[start:], &raw); err != nil {
		return ""
	}
	managed, ok := raw.Providers[kimiManagedProvider]
	if !ok {
		return ""
	}
	if managed.OAuth != nil {
		if region := kimiRegionOfURL(managed.OAuth.OAuthHost); region != "" {
			return region
		}
		if managed.OAuth.Key == "oauth/kimi-code" {
			return kimiRegionMainland
		}
	}
	return kimiRegionOfURL(managed.BaseURL)
}

// kimiRegionOfURL is the site a Kimi URL belongs to — auth., api., www. — or "" for any other host
// (a custom environment's).
func kimiRegionOfURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	switch {
	case host == "kimi.ai" || strings.HasSuffix(host, ".kimi.ai"):
		return kimiRegionGlobal
	case host == "kimi.com" || strings.HasSuffix(host, ".kimi.com"):
		return kimiRegionMainland
	}
	return ""
}
