package main

import (
	"fmt"
	"math/big"
	"regexp"
	"strings"
)

// A session reaches the gateway in either spelling the control plane hands out: its UUID, as hints and NATS subjects
// name it, or its base62 public id, as every response body writes ids (src/shared/src/codec.ts, toUuid). A runner may
// hold either. The gateway names a session by its UUID wherever two spellings would part: in a live subject, in the
// counts of its watchers, in the sessions a heartbeat says it supervises.

const base62Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

var maxUUID = new(big.Int).Lsh(big.NewInt(1), 128)

// sessionUUID is an id in its canonical spelling, a lowercase UUID; false when it is neither a UUID nor a base62 id of
// one.
func sessionUUID(id string) (string, bool) {
	if uuidPattern.MatchString(id) {
		return strings.ToLower(id), true
	}
	if id == "" || len(id) > 22 {
		return "", false
	}
	n := new(big.Int)
	base := big.NewInt(62)
	for _, r := range id {
		v := strings.IndexRune(base62Alphabet, r)
		if v < 0 {
			return "", false
		}
		n.Mul(n, base)
		n.Add(n, big.NewInt(int64(v)))
	}
	if n.Cmp(maxUUID) >= 0 {
		return "", false
	}
	hex := fmt.Sprintf("%032x", n)
	return hex[0:8] + "-" + hex[8:12] + "-" + hex[12:16] + "-" + hex[16:20] + "-" + hex[20:32], true
}
