package main

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
	"time"
)

// The caller lets go of an idle connection first. Either side of a kept-alive connection may close it once it is
// idle, and a request the caller sends just as the server closes it is reset. So every client of the runner that talks
// to the Orbit server keeps an idle connection for less time than the web gateway does (gateway/nginx.conf,
// keepalive_timeout), the same rule the apiserver keeps with its own callers (src/apiserver/src/common/idle-connections.ts).
//
// Read from the gateway's configuration as it is written, and from each client as the runner builds it: a client given
// a longer idle timeout, or a gateway given a shorter one, fails here.
func TestRunnerClientsLetGoOfIdleConnectionsBeforeTheWebGateway(t *testing.T) {
	conf, err := os.ReadFile(filepath.Join("..", "..", "gateway", "nginx.conf"))
	if err != nil {
		t.Fatal(err)
	}
	set := regexp.MustCompile(`(?m)^\s*keepalive_timeout\s+(\d+)s?\s*;`).FindAllSubmatch(conf, -1)
	if len(set) != 1 {
		t.Fatalf("gateway/nginx.conf sets keepalive_timeout %d times; read it as it is written now", len(set))
	}
	seconds, _ := strconv.Atoi(string(set[0][1]))
	gateway := time.Duration(seconds) * time.Second

	link := newLinkClient("https://orbit.invalid", "token", "process", nil)
	clients := map[string]*http.Client{
		"the runner's API client (Transport)": NewTransport("https://orbit.invalid", "token").client,
		"the link token client":               link.api,
		"the link dial client":                link.dial,
		"the person's CLI client":             userAPIClient,
		"the wiki door's client":              newWikiClient(NewTransport("https://orbit.invalid", "token").client),
	}
	for name, client := range clients {
		rt := client.Transport
		if rt == nil {
			rt = http.DefaultTransport
		}
		tr, ok := rt.(*http.Transport)
		if !ok {
			t.Fatalf("%s: a %T, not an *http.Transport; say here how long it keeps an idle connection", name, rt)
		}
		if tr.DisableKeepAlives {
			continue
		}
		// Go's idle timer starts once the answer is read, after the gateway's; 10 s covers that and a slow client.
		if tr.IdleConnTimeout <= 0 || tr.IdleConnTimeout+10*time.Second > gateway {
			t.Errorf("%s keeps an idle connection %v and the web gateway %v: the runner must let go at least 10 s sooner, "+
				"or a request it sends as the gateway closes the connection is reset", name, tr.IdleConnTimeout, gateway)
		}
	}
}
