# Lab only (docs/managed-runner-lab.md, "Single-writer protection (T02a)"): the managed runner image
# with the lab test server's CA added to the system trust store. The manager's Pod mounts only its
# claim, emptyDirs and its bootstrap Secret, and the admission guard refuses any other volume, so the
# lab CA cannot reach the runner as a ConfigMap the way the standalone path's does. `base` is the
# product image, built from deploy/managed-runner/image and passed as an OCI layout; nothing is pushed.
#   docker buildx build --build-context base=oci-layout://DIR@sha256:DIGEST \
#     --file scripts/managed-runner/lab/lab-ca-image.Dockerfile CONTEXT_WITH_ca.crt
FROM base
USER 0:0
COPY ca.crt /usr/local/share/ca-certificates/orbit-mr-lab-test-ca.crt
RUN update-ca-certificates
USER 10001:10001
