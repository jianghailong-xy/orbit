module orbit-hostd-e2e-stubserver

go 1.23

// The runner link's protocol is runner-go's own: the stub speaks it with the runner's generated
// definitions (orbit/linkpb), never a copy.
replace orbit => ../../../src/runner-go

require (
	github.com/coder/websocket v1.8.15
	google.golang.org/protobuf v1.36.12
	orbit v0.0.0-00010101000000-000000000000
)
