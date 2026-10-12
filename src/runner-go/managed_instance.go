package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
)

// The managed runner instance protocol (docs/managed-runner-design.md, "Identity and durable
// mapping"; the control plane's half is src/apiserver/src/managed-runners/managed-runner-instance.ts).
//
// A runner the Orbit manager runs in a Kubernetes Pod is told which instance it is by the Pod
// itself, through the Downward API: the generation annotation the manager reserved and the Pod's
// own UID (deploy/managed-runner/runner-pod.yaml.example; the image entrypoint checks them against
// its bootstrap Secret and passes them on). Every request this binary makes with a credential then
// carries both, and declares managedRunnerInstanceCapabilityV1, so the control plane accepts the
// managed runner's credential only from the instance it authorized and refuses a predecessor's.
//
// A self-managed runner has neither variable and sends nothing new. A control plane that predates
// the protocol ignores the headers and the capability token, as it ignores any it does not know.
const (
	envManagedRunnerGeneration        = "ORBIT_MANAGED_RUNNER_GENERATION"
	envManagedRunnerPodUID            = "ORBIT_MANAGED_RUNNER_POD_UID"
	managedRunnerInstanceCapabilityV1 = "managed-runner-instance-v1"
	managedRunnerGenerationHeader     = "X-Orbit-Managed-Runner-Generation"
	managedRunnerPodUIDHeader         = "X-Orbit-Managed-Runner-Pod-Uid"

	// The refusals after which the control plane will never accept this instance again.
	managedInstanceRequired      = "MANAGED_RUNNER_INSTANCE_REQUIRED"
	managedInstanceSuperseded    = "MANAGED_RUNNER_INSTANCE_SUPERSEDED"
	managedInstanceNotAuthorized = "MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED"
	managedInstanceFenced        = "MANAGED_RUNNER_INSTANCE_FENCED"
)

// managedInstance is the instance a managed runner is: what the Pod's Downward API said.
type managedInstance struct {
	Generation string
	PodUID     string
}

var (
	managedGenerationPattern = regexp.MustCompile(`^[1-9][0-9]{0,9}$`)
	managedPodUIDPattern     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// managedRunnerInstanceFromEnv reads the instance identity: nil and no error when neither variable
// is set (a self-managed runner), an error when only one is, or either is malformed — a managed Pod
// whose identity cannot be read must not run as though it had none.
func managedRunnerInstanceFromEnv(lookup func(string) (string, bool)) (*managedInstance, error) {
	generation, hasGeneration := lookup(envManagedRunnerGeneration)
	podUID, hasPodUID := lookup(envManagedRunnerPodUID)
	generation, podUID = strings.TrimSpace(generation), strings.ToLower(strings.TrimSpace(podUID))
	if !hasGeneration && !hasPodUID {
		return nil, nil
	}
	if !managedGenerationPattern.MatchString(generation) {
		return nil, fmt.Errorf("%s must be a positive generation number, got %q", envManagedRunnerGeneration, generation)
	}
	if !managedPodUIDPattern.MatchString(podUID) {
		return nil, fmt.Errorf("%s must be the Pod's UID, got %q", envManagedRunnerPodUID, podUID)
	}
	return &managedInstance{Generation: generation, PodUID: podUID}, nil
}

var (
	managedInstanceOnce   sync.Once
	managedInstanceCached *managedInstance
	// managedInstanceRevokedSeen: the run loop was told this instance is no longer authorized.
	managedInstanceRevokedSeen atomic.Bool
)

// currentManagedInstance is this process's instance, read once. A malformed identity reads as none
// here, so the requests carry no instance and a managed credential is refused; `orbit run` checks
// the identity first and refuses to start on it (checkManagedRunnerInstance).
func currentManagedInstance() *managedInstance {
	managedInstanceOnce.Do(func() {
		managedInstanceCached, _ = managedRunnerInstanceFromEnv(os.LookupEnv)
	})
	return managedInstanceCached
}

// checkManagedRunnerInstance is `orbit run`'s first step: a Pod that said which instance it is,
// but not readably, stops here.
func checkManagedRunnerInstance() error {
	instance, err := managedRunnerInstanceFromEnv(os.LookupEnv)
	if err != nil {
		return err
	}
	if instance != nil {
		logln(fmt.Sprintf("managed runner instance: generation %s, Pod %s", instance.Generation, instance.PodUID))
	}
	return nil
}

// setManagedInstanceHeaders adds this instance to a request that carries a credential: the two
// headers, and the capability token in X-Orbit-Runner-Capabilities. Nothing for a self-managed runner.
func setManagedInstanceHeaders(header http.Header) {
	instance := currentManagedInstance()
	if instance == nil {
		return
	}
	header.Set(managedRunnerGenerationHeader, instance.Generation)
	header.Set(managedRunnerPodUIDHeader, instance.PodUID)
	// The instance protocol, and idle sleep (managed_sleep.go): this binary reports its workload and
	// honours a sleep request, which only a managed instance is ever sent.
	declared := header.Get(runnerCapabilitiesHeader)
	for _, capability := range []string{managedRunnerInstanceCapabilityV1, managedRunnerSleepCapabilityV1} {
		present := false
		for _, token := range strings.Split(declared, ",") {
			if strings.TrimSpace(token) == capability {
				present = true
				break
			}
		}
		if present {
			continue
		}
		if declared == "" {
			declared = capability
		} else {
			declared += "," + capability
		}
	}
	header.Set(runnerCapabilitiesHeader, declared)
}

// managedInstanceEnv is the identity as KEY=VALUE pairs, for a child process whose environment is
// built from a list rather than inherited (an engine that hands `orbit mcp` only what it is told).
func managedInstanceEnv() []string {
	instance := currentManagedInstance()
	if instance == nil {
		return nil
	}
	return []string{envManagedRunnerGeneration + "=" + instance.Generation, envManagedRunnerPodUID + "=" + instance.PodUID}
}

// isManagedInstanceRevoked reports an answer after which the control plane will never accept this
// managed instance again: superseded by a later generation, fenced, not the authorized Pod, or a
// credential it no longer knows — the manager replaces the credential when it fences a generation
// or retires it. A self-managed runner is never told so; for it, every answer means what it did.
func isManagedInstanceRevoked(err error) bool {
	if currentManagedInstance() == nil {
		return false
	}
	httpErr, ok := err.(*transportHTTPError)
	if !ok {
		return false
	}
	if httpErr.statusCode == http.StatusUnauthorized {
		return true
	}
	if httpErr.statusCode != http.StatusForbidden {
		return false
	}
	var body struct {
		Code string `json:"code"`
	}
	if json.Unmarshal([]byte(httpErr.body), &body) != nil {
		return false
	}
	switch body.Code {
	case managedInstanceRequired, managedInstanceSuperseded, managedInstanceNotAuthorized, managedInstanceFenced:
		return true
	}
	return false
}
