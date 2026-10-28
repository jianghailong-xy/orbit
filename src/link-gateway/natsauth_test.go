package main

import (
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// TestNATSAuthorizationOnARealServer holds a real nats-server running nats.conf to what it allows: a client without a
// seed cannot connect at all, so it can neither read a session's live stream nor publish a runner's hints, and each of
// the two users can do what it does and nothing of the other's. Two apiserver processes ask and answer each other on
// api.> (src/apiserver/src/runners/relay-peers.ts), and the gateway can neither read that nor an apiserver's inbox, where
// an Antigravity code or a Cursor key crosses in a reply. It needs the server and both seeds:
//
//	scripts/runner-link/nats-auth-check.sh    # a throwaway nats-server with this nats.conf and fresh keys
//
// and staging-check-link.sh runs it against the staging stack's NATS.
func TestNATSAuthorizationOnARealServer(t *testing.T) {
	url := os.Getenv("LINK_TEST_NATS_AUTH_URL")
	apiSeed, gatewaySeed := os.Getenv("LINK_TEST_NATS_APISERVER_SEED"), os.Getenv("LINK_TEST_NATS_GATEWAY_SEED")
	if url == "" || apiSeed == "" || gatewaySeed == "" {
		t.Skip("LINK_TEST_NATS_AUTH_URL, LINK_TEST_NATS_APISERVER_SEED and LINK_TEST_NATS_GATEWAY_SEED are not set")
	}
	const session = "0190a0b0-0000-7000-8000-0000000000a1"
	const runner = "0190a0b0-0000-7000-8000-00000000000a"

	// No credentials: refused at connect.
	if nc, err := nats.Connect(url, nats.Name("natsauth_test anonymous"), nats.MaxReconnects(0)); err == nil {
		nc.Close()
		t.Fatal("a client without credentials connected")
	} else if !errors.Is(err, nats.ErrAuthorization) && !strings.Contains(strings.ToLower(err.Error()), "authorization") {
		t.Fatalf("a client without credentials was refused with %v, want an authorization violation", err)
	}
	// A seed nats.conf does not name: refused too.
	stranger := mustUserSeed(t)
	if nc, err := connectAs(url, "stranger", stranger); err == nil {
		nc.client.Close()
		t.Fatal("a client with an unknown key connected")
	}

	api, err := connectAs(url, "apiserver", apiSeed)
	if err != nil {
		t.Fatalf("the apiserver's seed: %v", err)
	}
	defer api.client.Close()
	gateway, err := connectAs(url, "gateway", gatewaySeed)
	if err != nil {
		t.Fatalf("the gateway's seed: %v", err)
	}
	defer gateway.client.Close()

	// What each does: hints and requests go from the apiserver to the gateway, live streams and answers the other way.
	// The gateway holds one subscription per runner subject, as hints.go does: nats-server lets a connection answer a
	// request once, and a connection that got it on two subscriptions may answer it on neither.
	hints := make(chan *nats.Msg, 16)
	if _, err := gateway.client.Subscribe("rnr."+runner, func(m *nats.Msg) {
		if m.Reply != "" {
			_ = m.Respond([]byte(`{"turnPrefixResponse":{}}`))
			return
		}
		hints <- m
	}); err != nil {
		t.Fatal(err)
	}
	live, _ := api.client.SubscribeSync("ses." + session + ".live")
	flush(t, gateway, api)
	if err := api.client.Publish("rnr."+runner, []byte(`{"hint":{"claim":{}}}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-hints:
	case <-time.After(5 * time.Second):
		t.Fatal("the gateway did not get the apiserver's hint")
	}
	if err := gateway.client.Publish("ses."+session+".live", []byte(`{"liveBatch":{}}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := live.NextMsg(5 * time.Second); err != nil {
		t.Fatalf("the apiserver did not get the gateway's live batch: %v", err)
	}
	// A request the gateway answers on its reply subject.
	if _, err := api.client.Request("rnr."+runner, []byte(`{"turnPrefixRequest":{"requestId":"r","sessionId":"`+session+`"}}`), 5*time.Second); err != nil {
		t.Fatalf("the gateway's answer to a request did not arrive: %v (gateway errors %v, apiserver errors %v)", err, gateway.errs, api.errs)
	}

	// And nothing of the other's: the gateway cannot publish hints, nor read live streams; the apiserver cannot publish
	// live streams, nor read hints.
	gateway.denied(t, "publish", "rnr."+runner, func() error { return gateway.client.Publish("rnr."+runner, []byte("forged")) })
	gateway.denied(t, "subscription", "ses."+session+".live", func() error {
		_, err := gateway.client.SubscribeSync("ses." + session + ".live")
		return err
	})
	api.denied(t, "publish", "ses."+session+".live", func() error { return api.client.Publish("ses."+session+".live", []byte("forged")) })
	api.denied(t, "subscription", "rnr."+runner, func() error {
		_, err := api.client.SubscribeSync("rnr." + runner)
		return err
	})
	// The forged messages reached nobody.
	if m, err := live.NextMsg(300 * time.Millisecond); err == nil {
		t.Fatalf("a live batch the apiserver may not publish arrived: %s", m.Data)
	}
	select {
	case m := <-hints:
		t.Fatalf("a hint the gateway may not publish arrived: %s", m.Data)
	case <-time.After(300 * time.Millisecond):
	}

	// Two apiserver processes: one says what it holds on api.held and answers a request on its own subject, once; the
	// other hears it and asks.
	const instance = "0190a0b0-0000-7000-8000-0000000000f1"
	holder, err := connectAs(url, "apiserver holder", apiSeed)
	if err != nil {
		t.Fatalf("a second apiserver connection: %v", err)
	}
	defer holder.client.Close()
	held, _ := api.client.SubscribeSync("api.held")
	if _, err := holder.client.Subscribe("api."+instance, func(m *nats.Msg) {
		_ = m.Respond([]byte(`{"code":"relay-auth-check"}`))
	}); err != nil {
		t.Fatal(err)
	}
	flush(t, holder, api)
	if err := holder.client.Publish("api.held", []byte(`{"instance":"`+instance+`","kind":"login-code"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := held.NextMsg(5 * time.Second); err != nil {
		t.Fatalf("one apiserver did not hear what another holds: %v", err)
	}
	if reply, err := api.client.Request("api."+instance, []byte(`{"type":"take-login-code"}`), 5*time.Second); err != nil {
		t.Fatalf("an apiserver's answer to another did not arrive: %v (holder errors %v, asker errors %v)", err, holder.errs, api.errs)
	} else if string(reply.Data) != `{"code":"relay-auth-check"}` {
		t.Fatalf("the answer was %q", reply.Data)
	}

	// The gateway reads none of it: not what the apiservers say or ask on api.>, not the answers in their inboxes, and
	// it cannot ask them.
	gateway.denied(t, "subscription", "api.>", func() error {
		_, err := gateway.client.SubscribeSync("api.>")
		return err
	})
	gateway.denied(t, "subscription", "_INBOX.>", func() error {
		_, err := gateway.client.SubscribeSync("_INBOX.>")
		return err
	})
	gateway.denied(t, "publish", "api."+instance, func() error {
		return gateway.client.Publish("api."+instance, []byte(`{"type":"take-login-code"}`))
	})
	gateway.denied(t, "publish", "api.held", func() error { return gateway.client.Publish("api.held", []byte("forged")) })
	if m, err := held.NextMsg(300 * time.Millisecond); err == nil {
		t.Fatalf("something the gateway may not say on api.held arrived: %s", m.Data)
	}
}

// natsUser is a connection as one of nats.conf's users, with the permission violations the server reported.
type natsUser struct {
	client *nats.Conn
	mu     sync.Mutex
	errs   []string
}

func connectAs(url, name, seed string) (*natsUser, error) {
	kp, err := natsUserKey(seed)
	if err != nil {
		return nil, err
	}
	pub, _ := kp.PublicKey()
	u := &natsUser{}
	u.client, err = nats.Connect(url, nats.Name("natsauth_test "+name), nats.MaxReconnects(0), nats.Nkey(pub, kp.Sign),
		nats.ErrorHandler(func(_ *nats.Conn, _ *nats.Subscription, err error) {
			u.mu.Lock()
			u.errs = append(u.errs, err.Error())
			u.mu.Unlock()
		}))
	return u, err
}

// denied does what the user may not and checks the server says so: a permissions violation naming the subject.
func (u *natsUser) denied(t *testing.T, what, subject string, do func() error) {
	t.Helper()
	if err := do(); err != nil {
		return // refused by the client already
	}
	_ = u.client.Flush()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		u.mu.Lock()
		for _, e := range u.errs {
			l := strings.ToLower(e)
			if strings.Contains(l, "permissions violation") && strings.Contains(l, what) && strings.Contains(e, subject) {
				u.mu.Unlock()
				return
			}
		}
		u.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no permissions violation for %s to %s; the server reported %v", what, subject, u.errs)
}

func flush(t *testing.T, users ...*natsUser) {
	t.Helper()
	for _, u := range users {
		if err := u.client.Flush(); err != nil {
			t.Fatal(err)
		}
	}
}

func mustUserSeed(t *testing.T) string {
	t.Helper()
	var out strings.Builder
	if code := nkeyMain(nil, &out, &out); code != 0 {
		t.Fatalf("nkey: %s", out.String())
	}
	for _, line := range strings.Split(out.String(), "\n") {
		if seed, ok := strings.CutPrefix(line, "seed="); ok {
			return seed
		}
	}
	t.Fatalf("no seed in %q", out.String())
	return ""
}

func TestNkeyPrintsOneNewUserPair(t *testing.T) {
	var a, b strings.Builder
	if nkeyMain(nil, &a, &a) != 0 || nkeyMain(nil, &b, &b) != 0 {
		t.Fatal("nkey failed")
	}
	lines := strings.Split(strings.TrimSpace(a.String()), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "seed=SU") || !strings.HasPrefix(lines[1], "public=U") {
		t.Fatalf("output %q", a.String())
	}
	seed, _ := strings.CutPrefix(lines[0], "seed=")
	kp, err := natsUserKey(seed)
	if err != nil {
		t.Fatal(err)
	}
	if pub, _ := kp.PublicKey(); "public="+pub != lines[1] {
		t.Fatalf("the public key %q is not the seed's", lines[1])
	}
	if a.String() == b.String() {
		t.Fatal("two runs printed the same pair")
	}
	if nkeyMain([]string{"extra"}, &a, &a) != 2 {
		t.Fatal("an argument was taken")
	}
	// An account or operator seed is not a user's.
	if _, err := natsUserKey("SAAJNCL5KWFHI2PYTMI6J5DNSRFWKIQW5DNBZ5OVLRDXYIQ5F4G2EOEB4A"); err == nil {
		t.Fatal("a seed that is not a user's was taken")
	}
}
