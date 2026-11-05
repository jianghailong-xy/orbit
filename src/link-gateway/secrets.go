package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"io"

	"github.com/nats-io/nkeys"
)

// secretsMain is `link-gateway secrets`: what a new deployment's runner link needs generated, printed once to standard
// output as .env lines: the apiserver's token signing key and its public half, the secret the gateway presents to the
// apiserver, and the NATS nkey pair of each of the two (docs/self-hosting.md, "Runner link"). scripts/install-server.sh
// and /upgrade's script write them into .env, so neither needs OpenSSL's Ed25519 or a base64 that takes -w0 on the host
// (a Mac has neither). Nothing is written anywhere else and nothing is kept, and it takes no argument, so nothing about
// them is left in a process list or a log.
func secretsMain(args []string, stdout, stderr io.Writer) int {
	if len(args) > 0 {
		fmt.Fprintln(stderr, "link-gateway secrets takes no arguments: it prints a new deployment's runner link secrets as .env lines")
		return 2
	}
	lines, err := newLinkSecrets()
	if err != nil {
		fmt.Fprintln(stderr, "making the runner link's secrets failed:", err)
		return 1
	}
	if _, err := stdout.Write(lines); err != nil {
		fmt.Fprintln(stderr, "writing the runner link's secrets failed:", err)
		return 1
	}
	return 0
}

// newLinkSecrets makes the lines, all of them or none, in one buffer, so that a reader takes them in one write.
func newLinkSecrets() ([]byte, error) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	signing, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		return nil, err
	}
	verifying, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		return nil, err
	}
	gatewayToken := make([]byte, 32)
	if _, err := rand.Read(gatewayToken); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	line := func(name, value string) { fmt.Fprintf(&out, "%s=%q\n", name, value) }
	line("RUNNER_LINK_SIGNING_KEY", base64PEM("PRIVATE KEY", signing))
	line("RUNNER_LINK_PUBLIC_KEY", base64PEM("PUBLIC KEY", verifying))
	line("RUNNER_LINK_GATEWAY_TOKEN", base64.StdEncoding.EncodeToString(gatewayToken))
	for _, who := range []string{"APISERVER", "GATEWAY"} {
		seed, public, err := newNATSUser()
		if err != nil {
			return nil, err
		}
		line("RUNNER_LINK_NATS_"+who+"_SEED", seed)
		line("RUNNER_LINK_NATS_"+who+"_KEY", public)
	}
	return out.Bytes(), nil
}

func base64PEM(kind string, der []byte) string {
	return base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}))
}

func newNATSUser() (seed, public string, err error) {
	kp, err := nkeys.CreateUser()
	if err != nil {
		return "", "", err
	}
	defer kp.Wipe()
	raw, err := kp.Seed()
	if err != nil {
		return "", "", err
	}
	if public, err = kp.PublicKey(); err != nil {
		return "", "", err
	}
	return string(raw), public, nil
}
