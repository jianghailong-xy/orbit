# The runner link gateway (README.md beside this file), as root Compose's link-gateway service runs it. Build from
# this directory:
#   docker build -t orbit-link-gateway:local src/link-gateway
#
# Go 1.27.3: the first release with every standard-library fix govulncheck reports for a public TLS and HTTP server
# built on this module (docs/dependency-security.md, "Link gateway dependencies"). Raise it, never lower it.
FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY . .
# The commit this image is built from, reported by link_gateway_build_info; "dev" when none is named.
ARG ORBIT_SOURCE_SHA
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${ORBIT_SOURCE_SHA:-dev}" -o /link-gateway .

# Nothing but the binary and the CA bundle the ACME client trusts: no shell, no package manager.
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /link-gateway /link-gateway
EXPOSE 8443 9464
ENTRYPOINT ["/link-gateway"]
CMD ["serve"]
