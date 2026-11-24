//go:build linux

package csi

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	csipb "github.com/container-storage-interface/spec/lib/go/csi"
	"google.golang.org/grpc"
)

const serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"

// InClusterSecrets reads Secrets with the plugin's own service account, which may get Secrets in its namespace and
// nothing else (drive-csi/rbac.yaml).
type InClusterSecrets struct {
	host   string
	client *http.Client
}

// NewInClusterSecrets is the reader of the Pod's service account.
func NewInClusterSecrets() (*InClusterSecrets, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, errors.New("not in a cluster: KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT are not set")
	}
	ca, err := os.ReadFile(filepath.Join(serviceAccountDir, "ca.crt"))
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("the service account's ca.crt holds no certificate")
	}
	return &InClusterSecrets{
		host:   "https://" + net.JoinHostPort(host, port),
		client: &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}},
	}, nil
}

// Get reads one Secret, or nil on 404. The token is read again for every request: the kubelet rotates it.
func (s *InClusterSecrets) Get(ctx context.Context, namespace, name string) (*Secret, error) {
	token, err := os.ReadFile(filepath.Join(serviceAccountDir, "token"))
	if err != nil {
		return nil, err
	}
	u := fmt.Sprintf("%s/api/v1/namespaces/%s/secrets/%s", s.host, url.PathEscape(namespace), url.PathEscape(name))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET secret %s/%s: HTTP %d: %s", namespace, name, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var object struct {
		Metadata struct {
			Annotations map[string]string `json:"annotations"`
		} `json:"metadata"`
		Data map[string][]byte `json:"data"` // base64 in JSON, which encoding/json decodes into []byte
	}
	if err := json.Unmarshal(body, &object); err != nil {
		return nil, err
	}
	return &Secret{Annotations: object.Metadata.Annotations, Data: object.Data}, nil
}

// Serve answers CSI on the unix socket endpoint until ctx ends.
func Serve(ctx context.Context, endpoint string, d *Driver) error {
	path := strings.TrimPrefix(endpoint, "unix://")
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	server := grpc.NewServer()
	csipb.RegisterIdentityServer(server, d)
	csipb.RegisterNodeServer(server, d)
	go func() {
		<-ctx.Done()
		server.GracefulStop()
	}()
	return server.Serve(listener)
}
