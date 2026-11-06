package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"strconv"
	"strings"
	"testing"
)

// parseSecretLines reads the output as Compose reads .env: one NAME="value" per line.
func parseSecretLines(t *testing.T, out []byte) map[string]string {
	t.Helper()
	values := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(out), "\n"), "\n") {
		name, quoted, ok := strings.Cut(line, "=")
		if !ok {
			t.Fatalf("not a NAME=value line: %d bytes", len(line))
		}
		value, err := strconv.Unquote(quoted)
		if err != nil {
			t.Fatalf("%s is not quoted: %v", name, err)
		}
		if _, repeated := values[name]; repeated {
			t.Fatalf("%s is printed twice", name)
		}
		values[name] = value
	}
	return values
}

func TestSecretsAreWhatTheApiserverGatewayAndNATSRead(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := secretsMain(nil, &out, &errOut); code != 0 || errOut.Len() != 0 {
		t.Fatalf("exit %d, stderr %q", code, errOut.String())
	}
	values := parseSecretLines(t, out.Bytes())
	want := []string{
		"RUNNER_LINK_SIGNING_KEY", "RUNNER_LINK_PUBLIC_KEY", "RUNNER_LINK_GATEWAY_TOKEN",
		"RUNNER_LINK_NATS_APISERVER_SEED", "RUNNER_LINK_NATS_APISERVER_KEY",
		"RUNNER_LINK_NATS_GATEWAY_SEED", "RUNNER_LINK_NATS_GATEWAY_KEY",
	}
	if len(values) != len(want) {
		t.Fatalf("%d lines, want %d", len(values), len(want))
	}
	for _, name := range want {
		if values[name] == "" {
			t.Fatalf("%s is empty", name)
		}
	}

	// The signing key is what the apiserver's readRunnerLink takes, base64 of an Ed25519 private key in PEM (PKCS#8)...
	raw, err := base64.StdEncoding.DecodeString(values["RUNNER_LINK_SIGNING_KEY"])
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(raw)
	if block == nil || block.Type != "PRIVATE KEY" {
		t.Fatal("the signing key is not PEM of a private key")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	private, ok := key.(ed25519.PrivateKey)
	if !ok {
		t.Fatalf("the signing key is a %T", key)
	}
	// ...and its public half is what this gateway reads, and verifies that key's signatures with.
	keys, err := parsePublicKeys(values["RUNNER_LINK_PUBLIC_KEY"])
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || !keys[0].Equal(private.Public()) {
		t.Fatal("the public key is not the signing key's public half")
	}

	// The apiserver refuses a gateway secret under 32 characters.
	if len(values["RUNNER_LINK_GATEWAY_TOKEN"]) < 32 {
		t.Fatalf("the gateway secret has %d characters", len(values["RUNNER_LINK_GATEWAY_TOKEN"]))
	}

	// Each seed is a user seed this gateway reads, of the public key beside it.
	for _, who := range []string{"APISERVER", "GATEWAY"} {
		kp, err := natsUserKey(values["RUNNER_LINK_NATS_"+who+"_SEED"])
		if err != nil {
			t.Fatalf("%s: %v", who, err)
		}
		public, err := kp.PublicKey()
		kp.Wipe()
		if err != nil || public != values["RUNNER_LINK_NATS_"+who+"_KEY"] {
			t.Fatalf("%s: the public key does not go with the seed (%v)", who, err)
		}
	}
	if values["RUNNER_LINK_NATS_APISERVER_SEED"] == values["RUNNER_LINK_NATS_GATEWAY_SEED"] {
		t.Fatal("the two NATS users share a seed")
	}
}

func TestSecretsAreNewEachTimeAndTakeNoArguments(t *testing.T) {
	var one, two, errOut bytes.Buffer
	if secretsMain(nil, &one, &errOut) != 0 || secretsMain(nil, &two, &errOut) != 0 {
		t.Fatal(errOut.String())
	}
	first, second := parseSecretLines(t, one.Bytes()), parseSecretLines(t, two.Bytes())
	for name, value := range first {
		if second[name] == value {
			t.Fatalf("%s came out the same twice", name)
		}
	}
	errOut.Reset()
	if code := secretsMain([]string{"x"}, &one, &errOut); code != 2 {
		t.Fatalf("exit %d with an argument", code)
	}
	if !strings.Contains(errOut.String(), "takes no arguments") {
		t.Fatalf("stderr %q", errOut.String())
	}
}
