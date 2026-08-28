package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
)

type runnerWriteContract struct {
	CapabilityRevision        int `json:"capabilityRevision"`
	SchemaRevision            int `json:"schemaRevision"`
	MinimumCapabilityRevision int `json:"minimumCapabilityRevision"`
	MinimumSchemaRevision     int `json:"minimumSchemaRevision"`
}

type releaseManifest struct {
	Version                   string `json:"version"`
	CapabilityRevision        int    `json:"capabilityRevision"`
	SchemaRevision            int    `json:"schemaRevision"`
	MinimumCapabilityRevision int    `json:"minimumCapabilityRevision"`
	MinimumSchemaRevision     int    `json:"minimumSchemaRevision"`
	ContractDigest            string `json:"contractDigest"`
}

func main() {
	if len(os.Args) != 4 {
		fatalf("usage: release-manifest VERSION CONTRACT OUTPUT")
	}

	source, err := os.ReadFile(os.Args[2])
	if err != nil {
		fatalf("read runner-write contract: %v", err)
	}
	var contract runnerWriteContract
	if err := json.Unmarshal(source, &contract); err != nil {
		fatalf("decode runner-write contract: %v", err)
	}
	if contract.CapabilityRevision < 1 || contract.SchemaRevision < 1 ||
		contract.MinimumCapabilityRevision < 1 || contract.MinimumSchemaRevision < 1 {
		fatalf("runner-write contract has invalid revision fields")
	}

	digest := sha256.Sum256(source)
	encoded, err := json.Marshal(releaseManifest{
		Version:                   os.Args[1],
		CapabilityRevision:        contract.CapabilityRevision,
		SchemaRevision:            contract.SchemaRevision,
		MinimumCapabilityRevision: contract.MinimumCapabilityRevision,
		MinimumSchemaRevision:     contract.MinimumSchemaRevision,
		ContractDigest:            hex.EncodeToString(digest[:]),
	})
	if err != nil {
		fatalf("encode release manifest: %v", err)
	}
	encoded = append(encoded, '\n')
	if err := os.WriteFile(os.Args[3], encoded, 0o644); err != nil {
		fatalf("write release manifest: %v", err)
	}
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
	os.Exit(1)
}
