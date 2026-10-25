package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"
)

// TLS for the runners' port (docs/runner-link-design.md §8): a certificate and key from files, reloaded whenever
// they change so a renewal or a rotation needs no restart, or certificates the gateway obtains and renews itself
// over ACME (TLS-ALPN-01, which needs the link's public port to be 443).

// certFiles serves the certificate in two files and reloads it when either changes.
type certFiles struct {
	certFile, keyFile string
	metrics           *gatewayMetrics
	log               *slog.Logger

	mu    sync.RWMutex
	cert  *tls.Certificate
	stamp [32]byte
}

// load reads both files; it keeps the certificate in use when they are unchanged or do not make a valid pair.
func (cf *certFiles) load() (changed bool, err error) {
	certPEM, err := os.ReadFile(cf.certFile)
	if err != nil {
		return false, err
	}
	keyPEM, err := os.ReadFile(cf.keyFile)
	if err != nil {
		return false, err
	}
	stamp := sha256.Sum256(append(append([]byte{}, certPEM...), keyPEM...))
	cf.mu.RLock()
	same := cf.cert != nil && stamp == cf.stamp
	cf.mu.RUnlock()
	if same {
		return false, nil
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return false, err
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return false, err
	}
	cert.Leaf = leaf
	cf.mu.Lock()
	cf.cert, cf.stamp = &cert, stamp
	cf.mu.Unlock()
	cf.metrics.tlsNotAfter.set(float64(leaf.NotAfter.Unix()))
	return true, nil
}

func (cf *certFiles) getCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	cf.mu.RLock()
	defer cf.mu.RUnlock()
	return cf.cert, nil
}

// reload checks the files every interval, and at once when kick fires (SIGHUP).
func (cf *certFiles) reload(ctx context.Context, interval time.Duration, kick <-chan os.Signal) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-kick:
		}
		changed, err := cf.load()
		if err != nil {
			// Files are replaced one at a time, by an ACME client or a copy: give a half-written pair a moment.
			time.Sleep(2 * time.Second)
			changed, err = cf.load()
		}
		switch {
		case err != nil:
			cf.metrics.tlsReloads.inc("error")
			cf.log.Error("certificate not reloaded; the one in use stays", "err", err)
		case changed:
			cf.metrics.tlsReloads.inc("ok")
			cf.mu.RLock()
			leaf := cf.cert.Leaf
			cf.mu.RUnlock()
			cf.log.Info("certificate reloaded", "subject", leaf.Subject.String(), "not_after", leaf.NotAfter.UTC().Format(time.RFC3339),
				"serial", leaf.SerialNumber.String())
		}
	}
}

// tlsSetup is the TLS configuration of the runners' port and the background work it needs.
type tlsSetup struct {
	config *tls.Config
	run    func(ctx context.Context, kick <-chan os.Signal)
}

func buildTLS(cfg config, m *gatewayMetrics, log *slog.Logger) (*tlsSetup, error) {
	switch cfg.TLSMode {
	case "off":
		return &tlsSetup{run: func(context.Context, <-chan os.Signal) {}}, nil
	case "files":
		cf := &certFiles{certFile: cfg.TLSCertFile, keyFile: cfg.TLSKeyFile, metrics: m, log: log}
		if _, err := cf.load(); err != nil {
			return nil, fmt.Errorf("TLS certificate %s and key %s: %w", cfg.TLSCertFile, cfg.TLSKeyFile, err)
		}
		return &tlsSetup{
			config: &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: cf.getCertificate, NextProtos: []string{"http/1.1"}},
			run: func(ctx context.Context, kick <-chan os.Signal) {
				cf.reload(ctx, cfg.TLSReloadInterval, kick)
			},
		}, nil
	case "acme":
		client := &acme.Client{DirectoryURL: cfg.ACMEDirectoryURL}
		if cfg.ACMECAFile != "" {
			pool, err := x509.SystemCertPool()
			if err != nil {
				pool = x509.NewCertPool()
			}
			pem, err := os.ReadFile(cfg.ACMECAFile)
			if err != nil {
				return nil, fmt.Errorf("LINK_ACME_CA_FILE: %w", err)
			}
			if !pool.AppendCertsFromPEM(pem) {
				return nil, errors.New("LINK_ACME_CA_FILE holds no PEM certificate")
			}
			client.HTTPClient = &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{
				TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
				Proxy:           http.ProxyFromEnvironment,
			}}
		}
		mgr := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(cfg.ACMEDomains...),
			Cache:      autocert.DirCache(cfg.ACMECacheDir),
			Email:      cfg.ACMEEmail,
			Client:     client,
		}
		return &tlsSetup{
			config: &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: mgr.GetCertificate,
				NextProtos: []string{"http/1.1", acme.ALPNProto}},
			run: func(context.Context, <-chan os.Signal) {},
		}, nil
	}
	return nil, fmt.Errorf("unknown TLS mode %q", cfg.TLSMode)
}
