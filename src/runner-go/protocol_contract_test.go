package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"testing"
)

func TestRunnerWriteContractGeneratedFromRepositoryContract(t *testing.T) {
	source, err := os.ReadFile("../../contracts/runner-write-protocol.json")
	if err != nil {
		t.Fatal(err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(source))
	if digest != runnerWriteContractDigest {
		t.Fatalf("runner digest=%s source digest=%s", runnerWriteContractDigest, digest)
	}
}

func TestUpgradeAndRollbackManifestCompatibility(t *testing.T) {
	current := Manifest{
		Version:            "0.1.141",
		CapabilityRevision: runnerWriteCapabilityRevision,
		SchemaRevision:     runnerWriteSchemaRevision,
		ContractDigest:     runnerWriteContractDigest,
	}
	if err := manifestProtocolCompatible(current); err != nil {
		t.Fatalf("current manifest rejected: %v", err)
	}
	// Version-only is the already-deployed N-1 release manifest and is the supported rollback lane.
	if err := manifestProtocolCompatible(Manifest{Version: "0.1.139"}); err != nil {
		t.Fatalf("N-1 rollback manifest rejected: %v", err)
	}
	divergent := current
	divergent.ContractDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	if err := manifestProtocolCompatible(divergent); err == nil {
		t.Fatal("same revisions with a divergent contract were accepted")
	}
	if err := manifestProtocolCompatible(Manifest{
		Version: "0.1.120", CapabilityRevision: 0, SchemaRevision: 1,
	}); err == nil {
		t.Fatal("an unsupported pre-N-1 revision was accepted")
	}
}

func TestDownloadedCLIContractMustMatchReleaseManifest(t *testing.T) {
	manifest := Manifest{
		Version:            "0.1.141",
		CapabilityRevision: runnerWriteCapabilityRevision,
		SchemaRevision:     runnerWriteSchemaRevision,
		ContractDigest:     runnerWriteContractDigest,
	}
	current := downloadedCapabilities{
		SchemaVersion:            runnerWriteSchemaRevision,
		CapabilityRevision:       runnerWriteCapabilityRevision,
		ServerCapabilityRevision: runnerWriteCapabilityRevision,
		ServerSchemaRevision:     runnerWriteSchemaRevision,
		ContractDigest:           runnerWriteContractDigest,
	}
	if !downloadedContractMatchesManifest(current, manifest) {
		t.Fatal("matching downloaded CLI contract was rejected")
	}
	current.ContractDigest = "different"
	if downloadedContractMatchesManifest(current, manifest) {
		t.Fatal("downloaded CLI with a different contract was accepted")
	}
	if !downloadedContractMatchesManifest(
		downloadedCapabilities{SchemaVersion: 1},
		Manifest{Version: "0.1.139"},
	) {
		t.Fatal("version-only N-1 rollback binary was rejected")
	}
}
