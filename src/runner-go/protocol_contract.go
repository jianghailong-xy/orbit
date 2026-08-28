package main

import "fmt"

// Generated from contracts/runner-write-protocol.json. The bootstrap suite hashes the source
// contract and compares both the Go and TypeScript values, so a revision bump cannot update only
// one side of the wire by accident.
const (
	runnerWriteCapabilityRevision        = 2
	runnerWriteSchemaRevision            = 2
	runnerWriteMinimumCapabilityRevision = 1
	runnerWriteMinimumSchemaRevision     = 1
	runnerWriteContractDigest            = "bbdd980c70dc56bfd09dfc311c41b3fdff8727912642ee4f529d8ddf36d3a696"
	runnerWriteLegacyContractDigest      = "runner-write-v1"

	runnerWriteCapabilityRevisionHeader = "X-Orbit-Runner-Capability-Revision"
	runnerWriteSchemaRevisionHeader     = "X-Orbit-Runner-Schema-Revision"
	runnerWriteContractDigestHeader     = "X-Orbit-Runner-Contract-Digest"
	runnerCLIVersionHeader              = "X-Orbit-CLI-Version"
)

// manifestProtocolCompatible is shared by automatic upgrade and the explicit repair/rollback
// door. A version-only manifest is the deployed N-1 shape. Once revision fields are present, the
// exact tuple and digest are required: a matching semver is not a wire contract.
func manifestProtocolCompatible(m Manifest) error {
	capabilityRevision := m.CapabilityRevision
	schemaRevision := m.SchemaRevision
	digest := m.ContractDigest
	if capabilityRevision == 0 && schemaRevision == 0 && digest == "" {
		capabilityRevision = runnerWriteMinimumCapabilityRevision
		schemaRevision = runnerWriteMinimumSchemaRevision
		digest = runnerWriteLegacyContractDigest
	}
	if capabilityRevision == runnerWriteCapabilityRevision && schemaRevision == runnerWriteSchemaRevision {
		if digest != runnerWriteContractDigest {
			return fmt.Errorf("runner contract digest mismatch at capability/schema revision %d/%d",
				capabilityRevision, schemaRevision)
		}
		return nil
	}
	if capabilityRevision == runnerWriteMinimumCapabilityRevision && schemaRevision == runnerWriteMinimumSchemaRevision {
		if digest != "" && digest != runnerWriteLegacyContractDigest {
			return fmt.Errorf("unknown N-1 runner contract digest %q", digest)
		}
		return nil
	}
	return fmt.Errorf("unsupported runner capability/schema revision %d/%d (supported %d/%d through %d/%d)",
		capabilityRevision, schemaRevision,
		runnerWriteMinimumCapabilityRevision, runnerWriteMinimumSchemaRevision,
		runnerWriteCapabilityRevision, runnerWriteSchemaRevision)
}
