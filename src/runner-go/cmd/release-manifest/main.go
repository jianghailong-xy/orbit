package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type runnerWriteContract struct {
	CapabilityRevision        int `json:"capabilityRevision"`
	SchemaRevision            int `json:"schemaRevision"`
	MinimumCapabilityRevision int `json:"minimumCapabilityRevision"`
	MinimumSchemaRevision     int `json:"minimumSchemaRevision"`
}

// releaseAsset is one platform's download: File is its name under /dl, and SHA256 the lowercase
// hex SHA-256 of that file's bytes exactly as served — the .gz itself, not the binary inside it.
type releaseAsset struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
}

type releaseManifest struct {
	Version                   string `json:"version"`
	CapabilityRevision        int    `json:"capabilityRevision"`
	SchemaRevision            int    `json:"schemaRevision"`
	MinimumCapabilityRevision int    `json:"minimumCapabilityRevision"`
	MinimumSchemaRevision     int    `json:"minimumSchemaRevision"`
	ContractDigest            string `json:"contractDigest"`
	// Keyed by platform, as the runner's platformKey names it: "linux-x64", "darwin-arm64", ….
	Assets map[string]releaseAsset `json:"assets"`
}

func main() {
	if len(os.Args) < 5 {
		fatalf("usage: release-manifest VERSION CONTRACT OUTPUT orbit-<platform>.gz...")
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

	assets := map[string]releaseAsset{}
	for _, path := range os.Args[4:] {
		file := filepath.Base(path)
		platform, ok := strings.CutPrefix(file, "orbit-")
		if ok {
			platform, ok = strings.CutSuffix(platform, ".gz")
		}
		if !ok || platform == "" {
			fatalf("asset %s is not named orbit-<platform>.gz", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			fatalf("read asset: %v", err)
		}
		sum := sha256.Sum256(data)
		assets[platform] = releaseAsset{File: file, SHA256: hex.EncodeToString(sum[:])}
	}

	digest := sha256.Sum256(source)
	encoded, err := json.Marshal(releaseManifest{
		Version:                   os.Args[1],
		CapabilityRevision:        contract.CapabilityRevision,
		SchemaRevision:            contract.SchemaRevision,
		MinimumCapabilityRevision: contract.MinimumCapabilityRevision,
		MinimumSchemaRevision:     contract.MinimumSchemaRevision,
		ContractDigest:            hex.EncodeToString(digest[:]),
		Assets:                    assets,
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
