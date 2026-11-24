# syntax=docker/dockerfile:1.7.1@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# The Drive CSI plugin and mount daemon, one static binary (src/drive-mount). Build from the repository root:
#   docker build -f deploy/managed-runner/drive-csi/Dockerfile -t <registry>/orbit-drive-csi:<source sha> .
FROM golang:1.27.1-trixie@sha256:3b77fc618ec235a1ab412de7737f120dd507c57e8d87de4cbb7994fb94275ed5 AS build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src/drive-mount
COPY src/drive-mount/go.mod src/drive-mount/go.sum ./
RUN go mod download
COPY src/drive-mount/ ./
RUN test "$(go env GOVERSION)" = go1.27.1 \
 && go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/orbit-drive-mount .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/orbit-drive-mount /usr/bin/orbit-drive-mount
ENTRYPOINT ["/usr/bin/orbit-drive-mount"]
