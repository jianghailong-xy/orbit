package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/url"
	"sort"
	"strings"
	"sync"
)

// The exact-value scrubber for owner-request secrets (docs/design/owner-request-secrets.md §5.4). One routine, built on
// integrationOutputRedactor and its carry: every value is matched raw, in base64 and base64url (padded or not), in hex
// and URL-encoded, and line by line when it has more than one line, and each match becomes "[redacted]".

// secretValueForms is every spelling of value the scrubber looks for. A form shorter than integrationOutputMinSecret
// is left out by the redactor: it could not be told from ordinary text.
func secretValueForms(value string) []string {
	forms := []string{
		value,
		base64.StdEncoding.EncodeToString([]byte(value)),
		base64.RawStdEncoding.EncodeToString([]byte(value)),
		base64.URLEncoding.EncodeToString([]byte(value)),
		base64.RawURLEncoding.EncodeToString([]byte(value)),
		hex.EncodeToString([]byte(value)),
		strings.ToUpper(hex.EncodeToString([]byte(value))),
		url.QueryEscape(value),
		url.PathEscape(value),
	}
	if trimmed := strings.TrimSpace(value); trimmed != value {
		forms = append(forms, trimmed)
	}
	if strings.Contains(value, "\n") {
		for _, line := range strings.Split(value, "\n") {
			forms = append(forms, strings.TrimRight(line, "\r"), strings.TrimSpace(line))
		}
	}
	return forms
}

// newSecretRedactor is an integrationOutputRedactor over values and their forms, and nothing else: no environment
// credential and no URL rule, so text with none of these values in it passes through unchanged.
func newSecretRedactor(values []string) *integrationOutputRedactor {
	r := &integrationOutputRedactor{}
	seen := map[string]bool{}
	for _, value := range values {
		for _, form := range secretValueForms(value) {
			if len(form) < integrationOutputMinSecret || seen[form] {
				continue
			}
			seen[form] = true
			r.secrets = append(r.secrets, form)
		}
	}
	sort.Slice(r.secrets, func(i, j int) bool { return len(r.secrets[i]) > len(r.secrets[j]) })
	return r
}

// holds reports whether text contains any of the redactor's secrets.
func (r *integrationOutputRedactor) holds(text []byte) bool {
	for _, secret := range r.secrets {
		if bytes.Contains(text, []byte(secret)) {
			return true
		}
	}
	return false
}

// pendingSecretSuffix is how many bytes at the end of text could still be the start of a secret, so a stream holds
// those back for the next write and no more. The carry of integrationOutputRedactor.carry is its bound.
func (r *integrationOutputRedactor) pendingSecretSuffix(text string) int {
	hold := 0
	for _, secret := range r.secrets {
		from := len(text) - (len(secret) - 1)
		if from < 0 {
			from = 0
		}
		for i := from; i < len(text); i++ {
			if len(text)-i <= hold {
				break
			}
			if text[i] == secret[0] && strings.HasPrefix(secret, text[i:]) {
				hold = len(text) - i
				break
			}
		}
	}
	return hold
}

// safeCut is where text can be cut so that no secret is split by the cut: before any tail that could still begin a
// secret (pendingSecretSuffix), and before any whole secret that would straddle that point.
func (r *integrationOutputRedactor) safeCut(text string) int {
	cut := len(text) - r.pendingSecretSuffix(text)
	for moved := true; moved; {
		moved = false
		for _, secret := range r.secrets {
			from := cut - len(secret) + 1
			if from < 0 {
				from = 0
			}
			to := cut + len(secret) - 1
			if to > len(text) {
				to = len(text)
			}
			if at := strings.Index(text[from:to], secret); at >= 0 && from+at < cut {
				cut, moved = from+at, true
			}
		}
	}
	return cut
}

// secretScrubWriter scrubs a stream before it reaches out. Like the integration log uploader it holds bytes back
// between writes so a value split across two writes is whole when it is matched, but only a tail that could still
// begin a value waits (safeCut), so ordinary output is not delayed. Close writes what is held.
type secretScrubWriter struct {
	mu      sync.Mutex
	out     io.Writer
	r       *integrationOutputRedactor
	pending string
}

func newSecretScrubWriter(out io.Writer, r *integrationOutputRedactor) *secretScrubWriter {
	return &secretScrubWriter{out: out, r: r}
}

func (w *secretScrubWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	text := w.pending + string(p)
	cut := w.r.safeCut(text)
	w.pending = text[cut:]
	if _, err := io.WriteString(w.out, w.r.redact(text[:cut])); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (w *secretScrubWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	text := w.r.redact(w.pending)
	w.pending = ""
	_, err := io.WriteString(w.out, text)
	return err
}

// readerHoldsSecret reads r through and reports whether any secret is in it, a value split across two reads included.
func readerHoldsSecret(r io.Reader, red *integrationOutputRedactor) (bool, error) {
	carry := red.carry()
	reader := bufio.NewReaderSize(r, 64*1024)
	buf := make([]byte, 64*1024)
	var tail []byte
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			window := append(tail, buf[:n]...)
			if red.holds(window) {
				return true, nil
			}
			if len(window) > carry {
				window = window[len(window)-carry:]
			}
			tail = append([]byte(nil), window...)
		}
		if err == io.EOF {
			return false, nil
		}
		if err != nil {
			return false, err
		}
	}
}

// scrubSecretValue walks v and scrubs every string in it, returning v itself when nothing in it changed. A type it
// does not know is looked at as JSON, which is how every payload leaves the runner anyway.
func scrubSecretValue(v interface{}, r *integrationOutputRedactor) (interface{}, bool) {
	switch x := v.(type) {
	case nil:
		return v, false
	case string:
		if out := r.redact(x); out != x {
			return out, true
		}
		return v, false
	case map[string]interface{}:
		return scrubSecretMap(x, r)
	case []interface{}:
		var out []interface{}
		for i, item := range x {
			scrubbed, changed := scrubSecretValue(item, r)
			if changed && out == nil {
				out = append([]interface{}(nil), x...)
			}
			if out != nil {
				out[i] = scrubbed
			}
		}
		if out == nil {
			return v, false
		}
		return out, true
	case []string:
		var out []string
		for i, item := range x {
			scrubbed := r.redact(item)
			if scrubbed != item && out == nil {
				out = append([]string(nil), x...)
			}
			if out != nil {
				out[i] = scrubbed
			}
		}
		if out == nil {
			return v, false
		}
		return out, true
	case map[string]string:
		var out map[string]string
		for k, item := range x {
			if scrubbed := r.redact(item); scrubbed != item {
				if out == nil {
					out = make(map[string]string, len(x))
					for key, value := range x {
						out[key] = value
					}
				}
				out[k] = scrubbed
			}
		}
		if out == nil {
			return v, false
		}
		return out, true
	case bool, int, int64, float64, json.Number:
		return v, false
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return v, false
	}
	var generic interface{}
	if err := json.Unmarshal(raw, &generic); err != nil {
		return v, false
	}
	scrubbed, changed := scrubSecretValue(generic, r)
	if !changed {
		return v, false
	}
	return scrubbed, true
}

// scrubSecretMap is scrubSecretValue for a map, copying it only when something in it changed.
func scrubSecretMap(m map[string]interface{}, r *integrationOutputRedactor) (map[string]interface{}, bool) {
	var out map[string]interface{}
	for k, item := range m {
		scrubbed, changed := scrubSecretValue(item, r)
		if !changed {
			continue
		}
		if out == nil {
			out = make(map[string]interface{}, len(m))
			for key, value := range m {
				out[key] = value
			}
		}
		out[k] = scrubbed
	}
	if out == nil {
		return m, false
	}
	return out, true
}
