package main

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/nats-io/nkeys"
)

// The runner link's NATS authenticates its two clients by nkey (nats.conf beside this file): the apiserver and the
// gateway each hold a user seed, and the server holds only the public keys, which name the users and their
// permissions. A seed reaches a process through its environment alone and is never logged.

// natsUserKey reads a user nkey seed ("SU…").
func natsUserKey(seed string) (nkeys.KeyPair, error) {
	kp, err := nkeys.FromSeed([]byte(strings.TrimSpace(seed)))
	if err != nil {
		return nil, errors.New("it does not decode as an nkey seed")
	}
	pub, err := kp.PublicKey()
	if err != nil || !nkeys.IsValidPublicUserKey(pub) {
		kp.Wipe()
		return nil, errors.New("it is not a user seed")
	}
	return kp, nil
}

// nkeyMain is `link-gateway nkey`: a new user nkey pair, printed once to standard output as two .env-style lines, the
// seed first. Nothing is written anywhere else, so the seed is only where the operator puts it.
func nkeyMain(args []string, stdout, stderr io.Writer) int {
	if len(args) > 0 {
		fmt.Fprintln(stderr, "link-gateway nkey takes no arguments: it prints a new NATS user nkey pair, its seed and its public key")
		return 2
	}
	kp, err := nkeys.CreateUser()
	if err != nil {
		fmt.Fprintln(stderr, "making an nkey failed:", err)
		return 1
	}
	defer kp.Wipe()
	seed, err := kp.Seed()
	if err != nil {
		fmt.Fprintln(stderr, "reading the new seed failed:", err)
		return 1
	}
	pub, err := kp.PublicKey()
	if err != nil {
		fmt.Fprintln(stderr, "reading the new public key failed:", err)
		return 1
	}
	fmt.Fprintf(stdout, "seed=%s\npublic=%s\n", seed, pub)
	return 0
}
